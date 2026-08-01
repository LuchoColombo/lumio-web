// Lumio Web: sender (PC -> phone via animated QR) and receiver (camera scan).
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = {
    start: $('screen-start'),
    send: $('screen-send'),
    transmit: $('screen-transmit'),
    scan: $('screen-scan'),
    result: $('screen-result'),
  };

  function show(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('active', key === name);
    }
  }

  // Mirrors the app: payloads that fit one QR go raw so any camera reads them.
  const PLAIN_TEXT_MAX = 1000;

  // ============ SENDER ============

  let tx = null; // { frameAt, cycleLength, isPlain }
  let txTimer = null;
  let txIndex = 0;
  let txSpeedMs = 300;
  let txWakeLock = null;

  async function renderTxFrame() {
    const value = tx.frameAt(txIndex);
    await QRCode.toCanvas($('qrCanvas'), value, {
      errorCorrectionLevel: tx.isPlain ? 'M' : 'L',
      width: Math.min(380, Math.floor(window.innerWidth * 0.75)),
      margin: 0,
    });
    $('txCounter').textContent =
      tx.cycleLength > 1
        ? (txIndex % tx.cycleLength) + 1 + ' / ' + tx.cycleLength
        : '1 código';
    $('txHint').textContent = tx.isPlain
      ? 'Escaneable con cualquier cámara, sin la app'
      : 'En el teléfono: Lumio → Recibir, y apuntá la cámara acá';
  }

  function startTxLoop() {
    stopTxLoop();
    if (tx.cycleLength > 1) {
      txTimer = setInterval(() => {
        txIndex++;
        renderTxFrame();
      }, txSpeedMs);
    }
  }

  function stopTxLoop() {
    if (txTimer) {
      clearInterval(txTimer);
      txTimer = null;
    }
  }

  async function startTransmission(txObj) {
    tx = txObj;
    txIndex = 0;
    $('speedRow').hidden = tx.cycleLength <= 1;
    show('transmit');
    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').then((l) => (txWakeLock = l)).catch(() => {});
    }
    await renderTxFrame();
    startTxLoop();
  }

  function stopTransmission() {
    stopTxLoop();
    tx = null;
    if (txWakeLock) {
      txWakeLock.release().catch(() => {});
      txWakeLock = null;
    }
  }

  async function handleSendText() {
    const text = $('sendText').value.trim();
    if (!text) return;
    $('sendErr').textContent = '';

    if (text.length <= PLAIN_TEXT_MAX && !text.startsWith('OT')) {
      startTransmission({ frameAt: () => text, cycleLength: 1, isPlain: true });
      return;
    }
    try {
      const enc = await OT2.createFountainEncoder(OT2.utf8Encode(text), 't');
      startTransmission({ frameAt: enc.frameAt, cycleLength: enc.cycleLength, isPlain: false });
    } catch (e) {
      $('sendErr').textContent = 'No se pudo codificar el texto.';
    }
  }

  // Downscale + recompress like the app does: every KB costs ~2 QR codes.
  const IMAGE_MAX_DIM = 800;
  const IMAGE_QUALITY = 0.4;

  function fileToJpegBytes(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width, height } = img;
        const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(width, height));
        width = Math.round(width * scale);
        height = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error('encode failed'));
            blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf)), reject);
          },
          'image/jpeg',
          IMAGE_QUALITY,
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('load failed'));
      };
      img.src = url;
    });
  }

  async function handlePickImage(file) {
    $('sendErr').textContent = '';
    try {
      const bytes = await fileToJpegBytes(file);
      const enc = await OT2.createFountainEncoder(bytes, 'i');
      startTransmission({ frameAt: enc.frameAt, cycleLength: enc.cycleLength, isPlain: false });
    } catch (e) {
      $('sendErr').textContent = 'No se pudo procesar la imagen.';
    }
  }

  // ============ RECEIVER ============

  let stream = null;
  let scanning = false;
  let decoder = new OT2.FountainDecoder();
  let detector = null;
  let wakeLock = null;
  let busy = false;

  async function startScan() {
    $('startErr').textContent = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (e) {
      $('startErr').textContent =
        'No se pudo acceder a la cámara. Dale permiso al navegador e intentá de nuevo.';
      show('start');
      return;
    }

    detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch (e) {
        detector = null;
      }
    }

    if (navigator.wakeLock) {
      navigator.wakeLock.request('screen').then((l) => (wakeLock = l)).catch(() => {});
    }

    const video = $('video');
    video.srcObject = stream;
    await video.play();

    decoder = new OT2.FountainDecoder();
    scanning = true;
    $('progressFill').style.width = '0%';
    $('scanStatus').textContent = 'Buscando el código...';
    show('scan');
    requestAnimationFrame(tick);
  }

  function stopScan() {
    scanning = false;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  async function tick() {
    if (!scanning) return;
    const video = $('video');
    if (video.readyState >= 2 && !busy) {
      busy = true;
      try {
        const raw = await readQR(video);
        if (raw) await handleValue(raw);
      } catch (e) {
        // keep scanning
      }
      busy = false;
    }
    requestAnimationFrame(tick);
  }

  async function readQR(video) {
    if (detector) {
      const codes = await detector.detect(video);
      return codes.length ? codes[0].rawValue : null;
    }
    const canvas = $('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height);
    return code ? code.data : null;
  }

  async function handleValue(raw) {
    const frame = OT2.parseFountainFrame(raw);
    if (frame) {
      const { progress, complete } = decoder.addFrame(frame);
      $('progressFill').style.width = Math.round(progress * 100) + '%';
      $('scanStatus').textContent =
        'Recibiendo... ' + Math.round(progress * 100) + '% (' + decoder.blocks.size + '/' + decoder.k + ')';
      if (complete) {
        const result = await decoder.result();
        if (!result) {
          $('scanStatus').textContent = 'Error de integridad, reintentando...';
          return;
        }
        stopScan();
        showResult(result);
      }
      return;
    }

    if (raw.startsWith('OTN:')) {
      $('scanStatus').textContent =
        'Ese contenido es un video: por ahora se necesita la app Lumio para recibirlo.';
      return;
    }

    if (raw.startsWith('OT:')) return; // legacy animated frame, ignore

    stopScan();
    showResult({ type: 't', bytes: new TextEncoder().encode(raw) });
  }

  function showResult(result) {
    $('resultText').hidden = true;
    $('resultImg').hidden = true;
    $('btnCopy').hidden = true;
    $('btnOpen').hidden = true;
    $('btnDownload').hidden = true;

    if (result.type === 't') {
      const text = OT2.utf8Decode(result.bytes);
      $('resultText').textContent = text;
      $('resultText').hidden = false;
      $('btnCopy').hidden = false;
      $('btnCopy').onclick = async () => {
        try {
          await navigator.clipboard.writeText(text);
          $('btnCopy').textContent = 'Copiado ✓';
          setTimeout(() => ($('btnCopy').textContent = 'Copiar texto'), 2000);
        } catch (e) {
          // clipboard unavailable
        }
      };
      const trimmed = text.trim();
      if (/^https?:\/\/\S+$/i.test(trimmed)) {
        $('btnOpen').href = trimmed;
        $('btnOpen').hidden = false;
      }
    } else {
      const blob = new Blob([result.bytes], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      $('resultImg').src = url;
      $('resultImg').hidden = false;
      $('btnDownload').href = url;
      $('btnDownload').download = 'lumio-imagen.jpg';
      $('btnDownload').hidden = false;
    }
    show('result');
  }

  // ============ WIRING ============

  $('btnGoSend').onclick = () => show('send');
  $('btnStart').onclick = startScan;
  $('btnAgain').onclick = startScan;
  $('btnCancel').onclick = () => {
    stopScan();
    show('start');
  };
  for (const el of document.querySelectorAll('[data-back]')) {
    el.onclick = () => show('start');
  }

  $('btnPaste').onclick = async () => {
    try {
      $('sendText').value = await navigator.clipboard.readText();
    } catch (e) {
      $('sendErr').textContent =
        'El navegador no dejó leer el portapapeles: pegá con Ctrl+V en el cuadro de texto.';
    }
  };
  $('btnSendText').onclick = handleSendText;
  $('btnPickImage').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) handlePickImage(file);
  };
  $('btnStopTx').onclick = () => {
    stopTransmission();
    show('send');
  };
  for (const btn of document.querySelectorAll('.speedBtn')) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll('.speedBtn')) b.classList.remove('active');
      btn.classList.add('active');
      txSpeedMs = parseInt(btn.dataset.ms, 10);
      if (tx) startTxLoop();
    };
  }
})();
