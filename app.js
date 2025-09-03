// === UI ===
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx2d = canvas.getContext('2d');
const btnStart = document.getElementById('btnStart');
const btnStop  = document.getElementById('btnStop');
const statusEl = document.getElementById('status');
const blinkEl  = document.getElementById('blinkCount');
const browEl   = document.getElementById('browCount');
const mouthEl  = document.getElementById('mouthCount');
document.getElementById('year').textContent = new Date().getFullYear();

// === Estado ===
let stream = null;
let running = false;
let paintLoopId = null;
let mirror = true;
let currentDeviceId = null;

// ====== Controles (selector de cámara + espejo) ======
(function injectControls() {
  const panelCardBody = document.querySelector('#panel .card-body');
  if (!panelCardBody) return;

  // si ya quitaste la parte de sensibilidad/FPS del HTML, no pasa nada.
  // Aquí solo inyectamos selector de cámara y toggle espejo.
  panelCardBody.insertAdjacentHTML('beforeend', `
    <hr>
    <div class="row gy-2">
      <div class="col-12">
        <label class="form-label mb-1">Cámara</label>
        <select id="cameraSelect" class="form-select form-select-sm">
          <option value="">(Detectando cámaras...)</option>
        </select>
      </div>
      <div class="col-12 d-flex align-items-center gap-2">
        <div class="form-check form-switch">
          <input class="form-check-input" type="checkbox" id="mirrorToggle" checked>
          <label class="form-check-label" for="mirrorToggle">Espejo (flip horizontal)</label>
        </div>
      </div>
    </div>
  `);

  document.getElementById('mirrorToggle').addEventListener('change', e => { mirror = e.target.checked; });
  populateCameras();
})();

async function populateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const sel = document.getElementById('cameraSelect');
    sel.innerHTML = '';
    if (cams.length === 0) {
      sel.innerHTML = `<option value="">No se encontraron cámaras</option>`;
      return;
    }
    cams.forEach((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Cámara ${i + 1}`;
      sel.appendChild(opt);
    });
    if (!currentDeviceId) currentDeviceId = cams[0].deviceId;
    sel.value = currentDeviceId;
    sel.onchange = async (e) => {
      currentDeviceId = e.target.value || null;
      if (running) {
        await stopCamera();
        await startCamera();
      }
    };
  } catch (e) {
    console.warn('No se pudieron enumerar cámaras:', e);
  }
}

// ====== MediaPipe FaceMesh ======
const faceMesh = new FaceMesh({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
});
faceMesh.setOptions({
  maxNumFaces: 1,
  refineLandmarks: true,
  minDetectionConfidence: 0.6,
  minTrackingConfidence: 0.6
});
faceMesh.onResults(onResults);

// ====== LANDMARKS & UTILIDADES ======
// OJOS (EAR)
const LEFT_EYE  = { left: 33, right: 133, top1: 159, top2: 158, bottom1: 145, bottom2: 153 };
const RIGHT_EYE = { left: 362, right: 263, top1: 386, top2: 385, bottom1: 374, bottom2: 380 };

// CEJAS (promedio de varios puntos superiores)
const LEFT_BROW_POINTS  = [70, 63, 105];
const RIGHT_BROW_POINTS = [300, 293, 334];

// PÁRPADO SUPERIOR (promedio)
const LEFT_EYE_TOP_POINTS  = [159, 158];
const RIGHT_EYE_TOP_POINTS = [386, 385];

// BOCA
const MOUTH_LEFT_CORNER  = 61;
const MOUTH_RIGHT_CORNER = 291;
const MOUTH_TOP_INNER    = 13;
const MOUTH_BOTTOM_INNER = 14;

// Helpers geométricos
function dist(a, b){const dx=a.x-b.x,dy=a.y-b.y;return Math.hypot(dx,dy);}
function ear(eye,lm){
  const p1=lm[eye.left],p4=lm[eye.right],p2=lm[eye.top1],p3=lm[eye.top2],p6=lm[eye.bottom1],p5=lm[eye.bottom2];
  return (dist(p2,p6)+dist(p3,p5))/(2*dist(p1,p4));
}
function avgPoint(lm, idxs){
  let x=0,y=0; for(const i of idxs){ x+=lm[i].x; y+=lm[i].y; }
  const n=idxs.length; return {x:x/n,y:y/n};
}
function eyeWidth(lm, eye){ return dist(lm[eye.left], lm[eye.right]); }

// Métrica combinada de boca (robusta a escala)
function mouthScoreCombined(lm){
  const left=lm[MOUTH_LEFT_CORNER], right=lm[MOUTH_RIGHT_CORNER];
  const top=lm[MOUTH_TOP_INNER], bottom=lm[MOUTH_BOTTOM_INNER];
  const vert = dist(top, bottom);
  const mouthW = dist(left, right);
  const eyesW = (eyeWidth(lm, LEFT_EYE) + eyeWidth(lm, RIGHT_EYE)) * 0.5;

  const marCorners = vert / (mouthW + 1e-6);
  const marEyeNorm = vert / (eyesW + 1e-6);

  return 0.5 * marCorners + 0.5 * marEyeNorm;
}

// GAP ceja-ojo normalizado por ancho de ojo
function browEyeGap(lm){
  const browL = avgPoint(lm, LEFT_BROW_POINTS);
  const eyeTopL = avgPoint(lm, LEFT_EYE_TOP_POINTS);
  const gapL = Math.abs(browL.y - eyeTopL.y) / (eyeWidth(lm, LEFT_EYE) + 1e-6);

  const browR = avgPoint(lm, RIGHT_BROW_POINTS);
  const eyeTopR = avgPoint(lm, RIGHT_EYE_TOP_POINTS);
  const gapR = Math.abs(browR.y - eyeTopR.y) / (eyeWidth(lm, RIGHT_EYE) + 1e-6);

  return (gapL + gapR) / 2;
}

// ====== Estado de métricas (suavizado) ======
let smoothEAR=null, smoothBrow=null, smoothMouthScore=null;
const ALPHA = 0.4; // 0 mucho smoothing, 1 nada

// Conteos y flags
let blinkCount=0,browCount=0,mouthCount=0;
let eyesClosed=false,browsRaised=false,mouthOpen=false;
let browBaseline=null,mouthBaseline=null,baselineFrames=0;

// Estabilidad de ojos y cooldown cejas
let eyesOpenStable = 0;
let eyesClosedStable = 0;
let browCooldown = 0;

const OPEN_STABLE_FRAMES = 4;     // p/ cejas
const BROW_COOLDOWN_FRAMES = 6;   // tras blink

// Persistencia + cooldown para boca
let mouthOnStable = 0;
let mouthOffStable = 0;
const MOUTH_ON_FRAMES = 3;   // frames ON seguidos para activar
const MOUTH_OFF_FRAMES = 3;  // frames OFF seguidos para desactivar
const MOUTH_COUNT_COOLDOWN = 6;
let mouthCooldown = 0;

// ====== Cámara (pintado directo desde <video>) ======
async function startCamera() {
  if (running) return;
  try {
    const constraints = {
      video: currentDeviceId ? { deviceId: { exact: currentDeviceId } }
                             : { facingMode: { ideal: 'user' }, width: { ideal: 960 }, height: { ideal: 540 } },
      audio: false
    };
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    console.log('[TRACK settings]', track.getSettings());

    video.srcObject = stream;

    await new Promise(res => { video.onloadedmetadata = () => res(); });
    await video.play();

    canvas.width  = video.videoWidth  || 960;
    canvas.height = video.videoHeight || 540;

    const camera = new Camera(video, {
      onFrame: async () => { try { await faceMesh.send({ image: video }); } catch {} },
      width: canvas.width, height: canvas.height
    });
    camera.start();

    const paint = () => {
      ctx2d.save();
      if (mirror) { ctx2d.translate(canvas.width, 0); ctx2d.scale(-1, 1); }
      ctx2d.fillStyle = '#000'; ctx2d.fillRect(0,0,canvas.width,canvas.height);
      if (video.readyState >= 2) ctx2d.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx2d.restore();
      paintLoopId = requestAnimationFrame(paint);
    };
    paint();

    running = true;
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusEl.textContent = 'Cámara encendida';
    populateCameras();
  } catch (err) {
    statusEl.textContent = 'Error al acceder a la cámara';
    console.error('[CAM ERROR]', err);
  }
}

async function stopCamera() {
  if (!running) return;
  running = false;
  btnStart.disabled = false;
  btnStop.disabled = true;
  statusEl.textContent = 'Cámara apagada';
  if (paintLoopId) { cancelAnimationFrame(paintLoopId); paintLoopId = null; }
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  ctx2d.clearRect(0,0,canvas.width,canvas.height);

  // reset baselines y suavizados
  browBaseline = mouthBaseline = null;
  baselineFrames = 0;
  smoothEAR = smoothBrow = smoothMouthScore = null;

  // reset estabilidad/cooldowns
  eyesOpenStable = eyesClosedStable = 0;
  browCooldown = 0;
  mouthOnStable = mouthOffStable = 0;
  mouthCooldown = 0;
}

// ====== Resultados de FaceMesh (conteos + overlay puntos) ======
function onResults(results) {
  if (!(results.multiFaceLandmarks && results.multiFaceLandmarks.length)) {
    statusEl.textContent = 'Rostro no detectado';
    return;
  }

  const lm = results.multiFaceLandmarks[0];

  // Métricas crudas
  const leftEAR  = ear(LEFT_EYE, lm);
  const rightEAR = ear(RIGHT_EYE, lm);
  const meanEAR  = (leftEAR + rightEAR) / 2;
  const gapBrow  = browEyeGap(lm);
  const mouthScore = mouthScoreCombined(lm);

  // Suavizado
  smoothEAR        = (smoothEAR        == null) ? meanEAR     : smoothEAR        * (1-ALPHA) + meanEAR     * ALPHA;
  smoothBrow       = (smoothBrow       == null) ? gapBrow     : smoothBrow       * (1-ALPHA) + gapBrow     * ALPHA;
  smoothMouthScore = (smoothMouthScore == null) ? mouthScore  : smoothMouthScore * (1-ALPHA) + mouthScore  * ALPHA;

  // --- Umbrales fijos/histéresis ---
  const earOn  = 0.19;       // cerrar
  const earOff = earOn + 0.04; // abrir

  // Boca: umbral adaptativo con mínimos absolutos (para que sí detecte)
  const baseM  = (mouthBaseline ?? 0.22);
  const mouthOn  = Math.max(baseM * 1.35, baseM + 0.035, 0.20);  // más fácil de activar
  const mouthOff = mouthOn - 0.020;                               // histéresis

  // Cejas
  const baseB  = (browBaseline ?? 0.55);
  const browOn  = Math.max(baseB * 1.10, baseB + 0.015);
  const browOff = browOn * 0.92;

  // Estabilidad ojos + cooldown cejas
  if (smoothEAR < earOn) { eyesClosedStable++; eyesOpenStable = 0; }
  else if (smoothEAR > earOff) { eyesOpenStable++; eyesClosedStable = 0; }
  if (browCooldown > 0) browCooldown--;

  // PARPADEO
  if (!eyesClosed && smoothEAR < earOn) eyesClosed = true;
  if (eyesClosed && smoothEAR > earOff) {
    eyesClosed = false;
    blinkCount++;
    blinkEl.textContent = `${blinkCount}`;
    browCooldown = BROW_COOLDOWN_FRAMES;
  }

  // Baselines: sólo con ojos abiertos y boca cerrada
  if (baselineFrames < 30 && eyesOpenStable >= OPEN_STABLE_FRAMES && smoothMouthScore < mouthOn*0.9) {
    browBaseline  = browBaseline  === null ? smoothBrow       : (browBaseline  *0.9 + smoothBrow       *0.1);
    mouthBaseline = mouthBaseline === null ? smoothMouthScore : (mouthBaseline *0.9 + smoothMouthScore *0.1);
    baselineFrames++;
  }

  // CEJAS (requiere ojos abiertos y sin cooldown)
  if (!browsRaised && browCooldown === 0 && eyesOpenStable >= OPEN_STABLE_FRAMES && smoothBrow > browOn) {
    browsRaised = true;
  }
  if (browsRaised && smoothBrow < browOff) {
    browsRaised = false;
    browCount++;
    browEl.textContent = `${browCount}`;
  }

  // BOCA con persistencia + cooldown
  if (smoothMouthScore > mouthOn) {
    mouthOnStable++;
    mouthOffStable = 0;
  } else if (smoothMouthScore < mouthOff) {
    mouthOffStable++;
    mouthOnStable = 0;
  } else {
    mouthOnStable = Math.max(0, mouthOnStable - 1);
    mouthOffStable = Math.max(0, mouthOffStable - 1);
  }

  if (!mouthOpen && mouthCooldown === 0 && mouthOnStable >= MOUTH_ON_FRAMES) {
    mouthOpen = true;
    mouthOnStable = 0;
  }
  if (mouthOpen && mouthOffStable >= MOUTH_OFF_FRAMES) {
    mouthOpen = false;
    mouthOffStable = 0;
    mouthCount++;
    mouthEl.textContent = `${mouthCount}`;
    mouthCooldown = MOUTH_COUNT_COOLDOWN;
  }
  if (mouthCooldown > 0) mouthCooldown--;

  // Overlay: landmarks
  ctx2d.save();
  if (mirror) { ctx2d.translate(canvas.width, 0); ctx2d.scale(-1, 1); }
  ctx2d.fillStyle = '#00e5ff';
  for (let i = 0; i < lm.length; i++) {
    const x = lm[i].x * canvas.width;
    const y = lm[i].y * canvas.height;
    ctx2d.beginPath();
    ctx2d.arc(x, y, 1.5, 0, Math.PI*2);
    ctx2d.fill();
  }
  ctx2d.restore();

  statusEl.textContent =
    `Rostro detectado • EAR=${smoothEAR.toFixed(3)} • Boca=${smoothMouthScore.toFixed(3)} • GAP=${smoothBrow.toFixed(3)}`;
}

// ====== Botones ======
btnStart.addEventListener('click', startCamera);
btnStop.addEventListener('click', stopCamera);
window.addEventListener('beforeunload', stopCamera);
