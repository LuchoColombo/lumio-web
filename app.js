// Lumio Web receiver: camera scan loop + OT2 fountain decoding.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = {
    start: $('screen-start'),
    scan: $('screen-scan'),
    result: $('screen-result'),
  };

  function show(name) {
    for (const key of Object.keys(screens)) {
      screens[key].classList.toggle('active', key === name);
    }
  }

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
      return;
    }

    // Native barcode detection where available (Android Chrome); jsQR fallback.
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

    // Any plain QR (text or URL): one-shot result.
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

  $('btnStart').onclick = startScan;
  $('btnCancel').onclick = () => {
    stopScan();
    show('start');
  };
  $('btnAgain').onclick = startScan;
})();
