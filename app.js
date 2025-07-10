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
    let elapsedTimeDisplay; // 経過時間表示用の要素を保持する変数

    // 経過時間表示用のDOM要素を動的に作成し、スコア表示の下に挿入
    if (scoreMinMaxDisplay && scoreMinMaxDisplay.parentElement) {
        const p = document.createElement('p');
        p.innerHTML = `経過時間: <span id="elapsed-time-display">---</span>`;
        scoreMinMaxDisplay.parentElement.insertAdjacentElement('afterend', p);
        elapsedTimeDisplay = document.getElementById('elapsed-time-display');
    }

    // --- 設定値 ---
    const TARGET_IMAGE_COUNT = 500;
    const COOLDOWN_PERIOD_MS = 5000;
    let STABILITY_THRESHOLD = 0.95; 

    // --- 状態変数 ---
    let savedImages = [];
    let lastSaveTime = 0;
    let isCapturing = false;
    let animationFrameId;
    let videoStream;
    let scoreMin = 1.0;
    let scoreMax = 0.0;
    let captureStartTime = 0;
    
    // ▼▼▼▼▼ 修正箇所 START ▼▼▼▼▼
    // センサー値を格納する変数を変更
    let currentRawAccel = { x: 0, y: 0, z: 0 };
    let lastRawAccel = { x: 0, y: 0, z: 0 };
    let currentRotationRate = { alpha: 0, beta: 0, gamma: 0 };
    let isFirstMotionEvent = true; // 最初のイベントを処理するためのフラグ
    // ▲▲▲▲▲ 修正箇所 END ▲▲▲▲▲

    // --- イベントリスナー ---
    startButton.addEventListener('click', handleStart);
    stopButton.addEventListener('click', stopCapture);
    downloadZipButton.addEventListener('click', downloadImagesAsZip);
    closeButton.addEventListener('click', () => modal.style.display = "none");
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = "none";
        }
    });
    thresholdSlider.addEventListener('input', (e) => {
        STABILITY_THRESHOLD = parseFloat(e.target.value);
        thresholdValue.textContent = STABILITY_THRESHOLD.toFixed(2);
    });

    // =================================================================
    //  メインの処理フロー
    // =================================================================

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

    function startCapture() {
        isCapturing = true;
        savedImages = [];
        lastSaveTime = 0;
        captureStartTime = Date.now(); // 経過時間計測用
        scoreMin = 1.0;
        scoreMax = 0.0;

        // センサー関連の変数をリセット
        currentRawAccel = { x: 0, y: 0, z: 0 };
        lastRawAccel = { x: 0, y: 0, z: 0 };
        currentRotationRate = { alpha: 0, beta: 0, gamma: 0 };
        isFirstMotionEvent = true; // 開始時にリセット

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
        
        stopButton.disabled = false;
        startButton.disabled = true;
        
        statusDisplay.textContent = `撮影を開始しました (0 / ${TARGET_IMAGE_COUNT})`;
        captureLoop();
    }

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
        
        if (savedImages.length > 0) {
            displayGallery();
        }
    }

    // =================================================================
    //  コア機能の関数
    // =================================================================

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
    
    // ▼▼▼▼▼ 修正箇所 START ▼▼▼▼▼
    function calculateStabilityScore() {
        // 加速度の「変化量」を計算する
        const deltaX = currentRawAccel.x - lastRawAccel.x;
        const deltaY = currentRawAccel.y - lastRawAccel.y;
        const deltaZ = currentRawAccel.z - lastRawAccel.z;

        // 加速度の変化量の大きさ（ベクトルの長さ）を計算
        // これが純粋な「動き」による加速度となる
        const net_a_change = Math.sqrt(deltaX**2 + deltaY**2 + deltaZ**2);
        
        // 角速度の大きさ(ベクトルの長さ)を計算
        const r = Math.sqrt(currentRotationRate.alpha**2 + currentRotationRate.beta**2 + currentRotationRate.gamma**2);
        
        // 加速度の変化量と角速度から「揺れ」の大きさをペナルティとして算出
        // 係数は、値のスケールが変化したため再調整
        const movementPenalty = (2.0 * net_a_change) + (0.02 * r);
        
        // 次のフレームのために現在の値を保存する
        lastRawAccel.x = currentRawAccel.x;
        lastRawAccel.y = currentRawAccel.y;
        lastRawAccel.z = currentRawAccel.z;

        // ペナルティが大きいほどスコアが0に近づくように指数関数で変換
        // 完全に静止していれば変化量は0に近づき、スコアはe^0 = 1に近づく
        return Math.exp(-movementPenalty);
    }
    // ▲▲▲▲▲ 修正箇所 END ▲▲▲▲▲

    function saveBestShot() {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        savedImages.push(canvas.toDataURL('image/jpeg'));
    }

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

    // ▼▼▼▼▼ 修正箇所 START ▼▼▼▼▼
    function handleMotionEvent(event) {
        // どのデバイスでも一貫した値が得やすい accelerationIncludingGravity を使用
        const acc = event.accelerationIncludingGravity;
        const rot = event.rotationRate;

        if (acc) {
            currentRawAccel.x = acc.x || 0;
            currentRawAccel.y = acc.y || 0;
            currentRawAccel.z = acc.z || 0;
            
            // 最初のイベントでは、lastとcurrentを同じ値に設定して変化量を0にする
            if (isFirstMotionEvent) {
                lastRawAccel.x = currentRawAccel.x;
                lastRawAccel.y = currentRawAccel.y;
                lastRawAccel.z = currentRawAccel.z;
                isFirstMotionEvent = false;
            }
        }
        if (rot) {
            currentRotationRate.alpha = rot.alpha || 0;
            currentRotationRate.beta = rot.beta || 0;
            currentRotationRate.gamma = rot.gamma || 0;
        }
    }
    // ▲▲▲▲▲ 修正箇所 END ▲▲▲▲▲

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

    function displayGallery() {
        captureContainer.style.display = 'none';
        galleryContainer.style.display = 'block';
        gallery.innerHTML = '';

        savedImages.forEach(src => {
            const img = document.createElement('img');
            img.src = src;
            img.addEventListener('click', () => {
                modalImage.src = src;
                modal.style.display = "block";
            });
            gallery.appendChild(img);
        });
    }

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