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
    // 古い要素の取得を削除
    // const accelData = document.getElementById('accel-data');
    // const gyroData = document.getElementById('gyro-data');
    // 新しい表形式のセル要素を取得
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

    // --- 設定値 ---
    const TARGET_IMAGE_COUNT = 500;
    const COOLDOWN_PERIOD_MS = 5000;
    let STABILITY_THRESHOLD = 0.95; // 安定度スコアのしきい値 (0-1)。1に近いほど厳しい。

    // --- 状態変数 ---
    let savedImages = [];
    let lastSaveTime = 0;
    let isCapturing = false;
    let animationFrameId;
    let videoStream;
    let scoreMin = 1.0;
    let scoreMax = 0.0;
    let currentAcceleration = { x: 0, y: 0, z: 0 };
    let currentRotationRate = { alpha: 0, beta: 0, gamma: 0 };

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
            // 1. センサーとカメラの許可と設定
            await requestSensorPermission();
            await setupCamera();

            // 2. センサーが利用可能かチェック
            statusDisplay.textContent = 'センサーをチェックしています...';
            const sensorReady = await checkSensorAvailability(3000); // 3秒待つ

            if (!sensorReady) {
                throw new Error('センサーデータを取得できませんでした。');
            }

            // 3. 撮影開始
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
        scoreMin = 1.0;
        scoreMax = 0.0;
        if (scoreMinMaxDisplay) scoreMinMaxDisplay.textContent = '--- / ---';
        
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

        // センサー値をリアルタイムで表示
        if (accelX) accelX.textContent = formatNumber(currentAcceleration.x, 2, 6);
        if (accelY) accelY.textContent = formatNumber(currentAcceleration.y, 2, 6);
        if (accelZ) accelZ.textContent = formatNumber(currentAcceleration.z, 2, 6);
        if (gyroAlpha) gyroAlpha.textContent = formatNumber(currentRotationRate.alpha, 2, 7);
        if (gyroBeta) gyroBeta.textContent = formatNumber(currentRotationRate.beta, 2, 7);
        if (gyroGamma) gyroGamma.textContent = formatNumber(currentRotationRate.gamma, 2, 7);

        const stabilityScore = calculateStabilityScore();
        scoreMin = Math.min(scoreMin, stabilityScore);
        scoreMax = Math.max(scoreMax, stabilityScore);

        // 安定度スコアをリアルタイムで表示
        stabilityScoreDisplay.textContent = formatNumber(stabilityScore, 2, 4);
        if (scoreMinMaxDisplay) {
            scoreMinMaxDisplay.textContent = `${formatNumber(scoreMin, 2, 4)} / ${formatNumber(scoreMax, 2, 4)}`;
        }
        
        const now = Date.now();
        if (now - lastSaveTime > COOLDOWN_PERIOD_MS) {
            if (stabilityScore > STABILITY_THRESHOLD) {
                saveBestShot();
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
        // `currentAcceleration`は event.acceleration から取得しており、
        // すでに重力加速度が除外された「純粋な動き」の値。
        // そのため、ベクトルの大きさ（純粋な動きの大きさ）をそのまま計算します。
        const net_a = Math.sqrt(currentAcceleration.x**2 + currentAcceleration.y**2 + currentAcceleration.z**2);
        
        // 角速度の大きさ(ベクトルの長さ)を計算
        const r = Math.sqrt(currentRotationRate.alpha**2 + currentRotationRate.beta**2 + currentRotationRate.gamma**2);
        
        // 加速度と角速度から「揺れ」の大きさをペナルティとして算出。
        // 係数は、手ぶれ程度の揺れでスコアが下がりすぎないように調整。
        const movementPenalty = (0.2 * net_a) + (0.02 * r);
        
        // ペナルティが大きいほどスコアが0に近づくように指数関数で変換。
        // 完全に静止していればペナルティは0に近づき、スコアはe^0 = 1に近づく。
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

    /**
     * 数値を符号付きで整形し、指定した幅で右揃えの文字列を返す。
     * 正の数には符号の代わりに半角スペースが先頭に付与され、
     * 負の数と表示上の桁が揃うように調整される。
     * @param {number} num - 対象の数値
     * @param {number} precision - 小数点以下の桁数
     * @param {number} totalWidth - 全体の文字幅（パディング含む）
     */
    function formatNumber(num, precision, totalWidth) {
        const value = num || 0;
        let str = value.toFixed(precision);
        if (value >= 0) {
            str = ' ' + str; // 正の数にはスペースを付与
        }
        return str.padStart(totalWidth, ' '); // 全体の幅に達するまで左をスペースで埋める
    }
    // =================================================================
    //  セットアップとパーミッション関連
    // =================================================================

    async function requestSensorPermission() {
        permissionOutput.innerHTML = '';
        // iOS 13+ では許可リクエストが必要
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
            // iOS 12.2以前やAndroidなど、許可が不要な環境
            window.addEventListener('devicemotion', handleMotionEvent);
            permissionOutput.innerHTML += 'DeviceMotionEvent: permission not required<br>';
        }
    }

    function handleMotionEvent(event) {
        // 重力加速度を含まない加速度を取得
        const acc = event.acceleration;
        const rot = event.rotationRate;
        if (acc) {
            currentAcceleration.x = acc.x || 0;
            currentAcceleration.y = acc.y || 0;
            currentAcceleration.z = acc.z || 0;
        }
        if (rot) {
            currentRotationRate.alpha = rot.alpha || 0;
            currentRotationRate.beta = rot.beta || 0;
            currentRotationRate.gamma = rot.gamma || 0;
        }
    }

    async function setupCamera() {
        if (videoStream) {
            videoStream.getTracks().forEach(track => track.stop());
        }
        const constraints = {
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                facingMode: 'environment' // 背面カメラを優先
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