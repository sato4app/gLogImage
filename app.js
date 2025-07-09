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
    const accelData = document.getElementById('accel-data');
    const gyroData = document.getElementById('gyro-data');
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
        
        // センサー表示をリセット
        accelData.textContent = '---';
        gyroData.textContent = '---';
        stabilityScoreDisplay.textContent = '---';
        if (scoreMinMaxDisplay) scoreMinMaxDisplay.textContent = '--- / ---';
        
        if (savedImages.length > 0) {
            displayGallery();
        }
    }

    // =================================================================
    //  コア機能の関数
    // =================================================================

    function captureLoop() {
        if (!isCapturing) return;

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
    
    function calculateStabilityScore() {
        // 重力(約9.8m/s^2)の影響を簡易的に除去
        const net_a = Math.abs(Math.sqrt(currentAcceleration.x**2 + currentAcceleration.y**2 + currentAcceleration.z**2) - 9.8);
        // 角速度の大きさ(ベクトルの長さ)を計算 (単位: deg/s)
        const r = Math.sqrt(currentRotationRate.alpha**2 + currentRotationRate.beta**2 + currentRotationRate.gamma**2);
        
        // 動き(加速度と角速度)が小さいほどスコアが1に近づくように計算。係数で重み付けを調整。
        return 1 / (1 + (0.5 * net_a) + (0.1 * r));
    }

    function saveBestShot() {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        savedImages.push(canvas.toDataURL('image/jpeg'));
    }

    /**
     * 数値を整形して、指定した幅で右揃えの文字列を返す
     * @param {number} num - 対象の数値
     * @param {number} precision - 小数点以下の桁数
     * @param {number} totalWidth - 全体の文字幅（パディング含む）
     */
    function formatNumber(num, precision, totalWidth) {
        return (num || 0).toFixed(precision).padStart(totalWidth, ' ');
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
        const acc = event.acceleration;
        const rot = event.rotationRate;
        if (acc) {
            currentAcceleration.x = acc.x || 0;
            currentAcceleration.y = acc.y || 0;
            currentAcceleration.z = acc.z || 0;
            accelData.textContent = `${formatNumber(acc.x, 2, 6)}, ${formatNumber(acc.y, 2, 6)}, ${formatNumber(acc.z, 2, 6)}`;
        }
        if (rot) {
            currentRotationRate.alpha = rot.alpha || 0;
            currentRotationRate.beta = rot.beta || 0;
            currentRotationRate.gamma = rot.gamma || 0;
            gyroData.textContent = `${formatNumber(rot.alpha, 2, 7)}, ${formatNumber(rot.beta, 2, 7)}, ${formatNumber(rot.gamma, 2, 7)}`;
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