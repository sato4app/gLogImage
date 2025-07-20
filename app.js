document.addEventListener('DOMContentLoaded', () => {

    // --- DOM要素の取得 ---
    const video = document.getElementById('cameraFeed');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');
    const statusDisplay = document.getElementById('status');
    const permissionOutput = document.getElementById('permissionOutput');
    const captureContainer = document.getElementById('capture-container');
    const galleryContainer = document.getElementById('gallery-container');
    const gallery = document.getElementById('gallery');
    const downloadZipButton = document.getElementById('downloadZipButton');
    const accelX = document.getElementById('accel-x');
    const accelY = document.getElementById('accel-y');
    const accelZ = document.getElementById('accel-z');
    const gyroAlpha = document.getElementById('gyro-alpha');
    const gyroBeta = document.getElementById('gyro-beta');
    const gyroGamma = document.getElementById('gyro-gamma');
    const stabilityScoreDisplay = document.getElementById('stability-score');
    const scoreMinMaxDisplay = document.getElementById('score-min-max');
    const thresholdSlider = document.getElementById('threshold-slider');
    const thresholdValue = document.getElementById('threshold-value');
    const modal = document.getElementById('modal');
    const modalImage = document.getElementById('modalImage');
    const closeButton = document.querySelector('.close-button');
    let modalCounter; // モーダル内の画像カウンター
    let elapsedTimeDisplay; // 経過時間表示用の要素を保持する変数

    // 経過時間表示用のDOM要素を動的に作成し、スコア表示の下に挿入
    if (scoreMinMaxDisplay && scoreMinMaxDisplay.parentElement) {
        const p = document.createElement('p');
        p.innerHTML = `経過時間: <span id="elapsed-time-display">---</span>`;
        scoreMinMaxDisplay.parentElement.insertAdjacentElement('afterend', p);
        elapsedTimeDisplay = document.getElementById('elapsed-time-display');
    }

    // モーダル内にカウンター要素を動的に作成
    if (modal) {
        const counterElement = document.createElement('div');
        counterElement.style.position = 'absolute';
        counterElement.style.top = '15px';
        counterElement.style.left = '15px';
        counterElement.style.color = 'white';
        counterElement.style.fontSize = '18px';
        counterElement.style.fontWeight = 'bold';
        counterElement.style.textShadow = '1px 1px 3px rgba(0,0,0,0.7)';
        counterElement.style.zIndex = '1001'; // 重なり順を最前面に
        modal.appendChild(counterElement);
        modalCounter = counterElement;
    }

    // --- アプリケーション設定値 ---
    const TARGET_IMAGE_COUNT = 500;
    const COOLDOWN_PERIOD_MS = 5000;
    // 安定度の閾値はHTMLのスライダーの初期値から取得する
    let STABILITY_THRESHOLD = parseFloat(thresholdSlider.value);

    // --- アプリケーションの状態を管理する変数 ---
    let savedImages = [];
    let lastSaveTime = 0;
    let isCapturing = false;
    let animationFrameId;
    let videoStream;
    let currentImageIndex = -1; // モーダルで表示中の画像のインデックス

    // --- スコアとセンサー関連の変数 ---
    let scoreMin = 1.0;
    let scoreMax = 0.0;
    let captureStartTime = 0;
    let currentRawAccel = { x: 0, y: 0, z: 0 };
    let lastRawAccel = { x: 0, y: 0, z: 0 };
    let currentRotationRate = { alpha: 0, beta: 0, gamma: 0 };
    let isFirstMotionEvent = true; // 最初のイベントを処理するためのフラグ

    // --- UI要素のイベントリスナー設定 ---
    startButton.addEventListener('click', handleStart);
    stopButton.addEventListener('click', stopCapture);
    downloadZipButton.addEventListener('click', downloadImagesAsZip);
    closeButton.addEventListener('click', () => modal.style.display = "none");
    modal.addEventListener('click', (e) => {
        // モーダルの背景クリックで閉じる
        if (e.target === modal) {
            modal.style.display = "none";
        }
    });
    thresholdSlider.addEventListener('input', (e) => {
        STABILITY_THRESHOLD = parseFloat(e.target.value);
        thresholdValue.textContent = STABILITY_THRESHOLD.toFixed(2);
    });

    // --- モーダル画像のスワイプ処理 ---
    let touchStartX = 0;
    modal.addEventListener('touchstart', e => {
        // スワイプ操作はモーダル内の画像上でのみ開始できるようにする
        if (e.target === modalImage) {
            touchStartX = e.changedTouches[0].screenX;
        }
    }, { passive: true });

    modal.addEventListener('touchend', e => {
        // スワイプ操作が画像上で開始されていた場合のみ処理
        if (e.target === modalImage && touchStartX !== 0) {
            const touchEndX = e.changedTouches[0].screenX;
            handleSwipe(touchStartX, touchEndX);
            touchStartX = 0; // 開始点をリセット
        }
    });


    // =================================================================
    //  メインの処理フロー
    // =================================================================

    // 撮影開始のメイン処理。センサー許可、カメラ準備、撮影開始を順次実行する。
    async function handleStart() {
        startButton.disabled = true;
        statusDisplay.textContent = '準備中...';

        try {
            await requestSensorPermission();
            await setupCamera();
            statusDisplay.textContent = 'センサーをチェックしています...';
            const sensorReady = await checkSensorAvailability(3000);

            if (!sensorReady) {
                throw new Error('センサーデータを取得できませんでした。');
            }
            startCapture();
        } catch (error) {
            statusDisplay.textContent = `エラー: ${error.message}`;
            alert(`開始できませんでした: ${error.message}\nデバイスが対応しているか、カメラとモーションセンサーの許可を確認してください。`);
            startButton.disabled = false;
        }
    }

    // 撮影プロセスを開始し、各種リセットを行ってから撮影ループを起動する。
    function startCapture() {
        isCapturing = true;
        savedImages = [];
        lastSaveTime = 0;
        // スコア計算の前提となるセンサー状態をセッション開始時にリセット

        lastRawAccel = { x: 0, y: 0, z: 0 };
        isFirstMotionEvent = true;

        resetDisplayAndValues();
        stopButton.disabled = false;
        startButton.disabled = true;
        
        statusDisplay.textContent = `撮影を開始しました (0 / ${TARGET_IMAGE_COUNT})`;
        captureLoop();
    }

    // 撮影を停止し、リソースを解放してギャラリーを表示する。
    function stopCapture() {
        if (!isCapturing) return;
        isCapturing = false;

        cancelAnimationFrame(animationFrameId);
        if (videoStream) {
            videoStream.getTracks().forEach(track => track.stop());
        }

        stopButton.disabled = true;
        startButton.disabled = false;
        statusDisplay.textContent = `撮影を終了しました。合計 ${savedImages.length} 枚の画像を保存しました。`;

        // 撮影が終了したので、経過時間の表示を初期値に戻す
        if (elapsedTimeDisplay) {
            elapsedTimeDisplay.textContent = '---';
        }
        
        // 撮影した画像があればギャラリーを表示
        if (savedImages.length > 0) {
            displayGallery();
        }
    }

    // =================================================================
    //  コア機能の関数
    // =================================================================

    // 撮影開始時に各種変数と画面表示を初期状態にリセットする。
    function resetDisplayAndValues() {
        // 状態変数のリセット
        scoreMin = 1.0;
        scoreMax = 0.0;
        captureStartTime = Date.now(); // 経過時間計測の開始点をリセット

        // 画面表示をリセット
        if (accelX) accelX.textContent = formatNumber(0, 2, 6);
        if (accelY) accelY.textContent = formatNumber(0, 2, 6);
        if (accelZ) accelZ.textContent = formatNumber(0, 2, 6);
        if (gyroAlpha) gyroAlpha.textContent = formatNumber(0, 2, 7);
        if (gyroBeta) gyroBeta.textContent = formatNumber(0, 2, 7);
        if (gyroGamma) gyroGamma.textContent = formatNumber(0, 2, 7);
        if (stabilityScoreDisplay) stabilityScoreDisplay.textContent = '----'.padStart(4, ' ');
        if (scoreMinMaxDisplay) scoreMinMaxDisplay.textContent = '--- / ---';
        if (elapsedTimeDisplay) {
            elapsedTimeDisplay.textContent = '0.0s';
        }
    }

    // 撮影中のメインループ。センサー値を表示し、安定度を評価して自動撮影する。
    function captureLoop() {
        if (!isCapturing) return;

        // 表示する加速度は重力込みの生データでOK
        if (accelX) accelX.textContent = formatNumber(currentRawAccel.x, 2, 6);
        if (accelY) accelY.textContent = formatNumber(currentRawAccel.y, 2, 6);
        if (accelZ) accelZ.textContent = formatNumber(currentRawAccel.z, 2, 6);
        if (gyroAlpha) gyroAlpha.textContent = formatNumber(currentRotationRate.alpha, 2, 7);
        if (gyroBeta) gyroBeta.textContent = formatNumber(currentRotationRate.beta, 2, 7);
        if (gyroGamma) gyroGamma.textContent = formatNumber(currentRotationRate.gamma, 2, 7);

        const stabilityScore = calculateStabilityScore();
        scoreMin = Math.min(scoreMin, stabilityScore);
        scoreMax = Math.max(scoreMax, stabilityScore);

        stabilityScoreDisplay.textContent = formatNumber(stabilityScore, 2, 4);
        if (scoreMinMaxDisplay) {
            scoreMinMaxDisplay.textContent = `${formatNumber(scoreMin, 2, 4)} / ${formatNumber(scoreMax, 2, 4)}`;
        }
        if (elapsedTimeDisplay) {
            const elapsedTime = (Date.now() - captureStartTime) / 1000;
            elapsedTimeDisplay.textContent = `${elapsedTime.toFixed(1)}s`;
        }
        
        const now = Date.now();
        if (now - lastSaveTime > COOLDOWN_PERIOD_MS) {
            if (stabilityScore > STABILITY_THRESHOLD) {
                saveBestShot();
                triggerFlash();
                // 撮影したので、次の撮影のためにスコアと経過時間をリセット
                resetDisplayAndValues();

                lastSaveTime = now;
                statusDisplay.textContent = `画像を保存しました！ (${savedImages.length} / ${TARGET_IMAGE_COUNT})`;
                if (savedImages.length >= TARGET_IMAGE_COUNT) {
                    stopCapture();
                    return;
                }
            }
        }
        animationFrameId = requestAnimationFrame(captureLoop);
    }
    
    // センサーデータから揺れの大きさを算出し、安定度スコア（0.0〜1.0）を返す。
    function calculateStabilityScore() {
        // 最初のフレームでは、前回値がないため計算をスキップし、スコア1.0を返す
        if (isFirstMotionEvent) {
            lastRawAccel.x = currentRawAccel.x;
            lastRawAccel.y = currentRawAccel.y;
            lastRawAccel.z = currentRawAccel.z;
            isFirstMotionEvent = false;
            return 1.0; // 最初のフレームは常に安定しているとみなす
        }

        // 加速度の「変化量」を計算する
        const deltaX = currentRawAccel.x - lastRawAccel.x;
        const deltaY = currentRawAccel.y - lastRawAccel.y;
        const deltaZ = currentRawAccel.z - lastRawAccel.z;

        // 加速度の変化量の大きさ（ベクトルの長さ）を計算。これが純粋な「動き」による加速度となる
        const net_a_change = Math.sqrt(deltaX**2 + deltaY**2 + deltaZ**2);
        
        // 角速度の大きさ(ベクトルの長さ)を計算
        const r = Math.sqrt(currentRotationRate.alpha**2 + currentRotationRate.beta**2 + currentRotationRate.gamma**2);
        
        // 加速度の変化量と角速度から「揺れ」の大きさをペナルティとして算出。係数は実験的に調整
        const movementPenalty = (2.0 * net_a_change) + (0.02 * r);
        
        // 次のフレームのために現在の値を保存する
        lastRawAccel.x = currentRawAccel.x;
        lastRawAccel.y = currentRawAccel.y;
        lastRawAccel.z = currentRawAccel.z;

        // ペナルティをスコアに変換して返す（大きいほど0に、小さいほど1に近づく）
        return Math.exp(-movementPenalty);
    }

    // 現在のビデオフレームをキャプチャし、画像として保存する。
    function saveBestShot() {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        savedImages.push(canvas.toDataURL('image/jpeg'));
    }

    // 撮影成功時に画面全体を白く光らせる視覚効果を発動する。
    function triggerFlash() {
        const flashOverlay = document.createElement('div');
        // フラッシュ用のオーバーレイ要素のスタイルを設定
        flashOverlay.style.position = 'fixed';
        flashOverlay.style.top = '0';
        flashOverlay.style.left = '0';
        flashOverlay.style.width = '100vw';
        flashOverlay.style.height = '100vh';
        flashOverlay.style.backgroundColor = 'white';
        flashOverlay.style.opacity = '0.7'; // 開始時の不透明度
        flashOverlay.style.zIndex = '9999'; // 最前面に表示
        flashOverlay.style.pointerEvents = 'none'; // マウスイベントを透過させる
        flashOverlay.style.transition = 'opacity 200ms ease-out'; // 0.2秒でフェードアウト

        document.body.appendChild(flashOverlay);

        // 短い時間表示してからフェードアウトを開始
        setTimeout(() => {
            flashOverlay.style.opacity = '0';
            // transition完了後に要素をDOMから削除
            setTimeout(() => document.body.removeChild(flashOverlay), 200);
        }, 50);
    }

    // 数値を指定された桁数と幅で整形し、右寄せ用の文字列を返す。
    function formatNumber(num, precision, totalWidth) {
        const value = num || 0;
        let str = value.toFixed(precision);
        if (value >= 0) {
            str = ' ' + str; 
        }
        return str.padStart(totalWidth, ' ');
    }
    
    // =================================================================
    //  セットアップとパーミッション関連
    // =================================================================

    // iOSデバイス向けにモーションセンサーへのアクセス許可を要求する。
    async function requestSensorPermission() {
        permissionOutput.innerHTML = '';
        if (typeof DeviceMotionEvent.requestPermission === 'function') {
            const permission = await DeviceMotionEvent.requestPermission();
            if (permission === 'granted') {
                window.addEventListener('devicemotion', handleMotionEvent);
                permissionOutput.innerHTML += 'DeviceMotionEvent: granted<br>';
            } else {
                permissionOutput.innerHTML += 'DeviceMotionEvent: denied<br>';
                throw new Error('モーションセンサーの許可が必要です。');
            }
        } else {
            window.addEventListener('devicemotion', handleMotionEvent);
            permissionOutput.innerHTML += 'DeviceMotionEvent: permission not required<br>';
        }
    }

    // devicemotionイベントを捕捉し、センサーの生データをグローバル変数に格納する。
    function handleMotionEvent(event) {
        const acc = event.accelerationIncludingGravity;
        const rot = event.rotationRate;

        // 加速度データを更新
        if (acc) {
            currentRawAccel.x = acc.x || 0;
            currentRawAccel.y = acc.y || 0;
            currentRawAccel.z = acc.z || 0;
        }
        // 角速度データを更新
        if (rot) {
            currentRotationRate.alpha = rot.alpha || 0;
            currentRotationRate.beta = rot.beta || 0;
            currentRotationRate.gamma = rot.gamma || 0;
        }
    }

    // デバイスのカメラを起動し、ビデオストリームをvideo要素に接続する。
    async function setupCamera() {
        if (videoStream) {
            videoStream.getTracks().forEach(track => track.stop());
        }
        const constraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'environment'
            }
        };
        videoStream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = videoStream;
        return new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
        });
    }

    // センサーが利用可能で、データが実際に送られてくるかを確認する。
    function checkSensorAvailability(timeout) {
        return new Promise((resolve) => {
            let sensorDataReceived = false;
            const checkMotionListener = () => { sensorDataReceived = true; };
            
            window.addEventListener('devicemotion', checkMotionListener, { once: true });

            setTimeout(() => {
                window.removeEventListener('devicemotion', checkMotionListener);
                resolve(sensorDataReceived);
            }, timeout);
        });
    }

    // =================================================================
    //  ギャラリーとダウンロード関連
    // =================================================================

    // スワイプ操作に応じて前後の画像を表示する
    function handleSwipe(startX, endX) {
        const swipeThreshold = 50; // 50px以上の移動でスワイプと判定
        const diff = startX - endX;

        if (Math.abs(diff) < swipeThreshold) {
            return; // 移動量が閾値未満なら何もしない
        }

        if (diff > 0) {
            // 右スワイプ（指を左に動かす）-> 次の画像
            showImageInModal(currentImageIndex + 1);
        } else {
            // 左スワイプ（指を右に動かす）-> 前の画像
            showImageInModal(currentImageIndex - 1);
        }
    }

    // 指定されたインデックスの画像をモーダルに表示する
    function showImageInModal(index) {
        // インデックスが画像の範囲外なら何もしない
        if (index < 0 || index >= savedImages.length) {
            return;
        }
        currentImageIndex = index;
        modalImage.src = savedImages[currentImageIndex];
        if (modalCounter) {
            modalCounter.textContent = `${currentImageIndex + 1} / ${savedImages.length}`;
        }
        modal.style.display = "block";
    }

    // 撮影した画像一覧（ギャラリー）を表示する。
    function displayGallery() {
        captureContainer.style.display = 'none';
        galleryContainer.style.display = 'block';
        gallery.innerHTML = '';

        savedImages.forEach((src, index) => {
            const img = document.createElement('img');
            img.src = src;
            img.addEventListener('click', () => {
                showImageInModal(index);
            });
            gallery.appendChild(img);
        });
    }

    // ギャラリーの全画像をZIPファイルにまとめてダウンロードする。
    function downloadImagesAsZip() {
        if (savedImages.length === 0) return;
        statusDisplay.textContent = '画像をZIPに圧縮しています...';
        const zip = new JSZip();
        savedImages.forEach((base64Data, index) => {
            const imageData = base64Data.split(',')[1];
            const fileName = `image_${String(index + 1).padStart(3, '0')}.jpg`;
            zip.file(fileName, imageData, { base64: true });
        });
        zip.generateAsync({ type: "blob" })
            .then(content => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(content);
                link.download = "best_shots.zip";
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                statusDisplay.textContent = 'ZIPファイルのダウンロードを開始しました。';
            });
    }
});