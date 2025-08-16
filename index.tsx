
import { GoogleGenAI, Type, Chat } from "@google/genai";

// --- DOM Element Selection ---
const uptimeEl = document.getElementById('uptime') as HTMLElement;
const currentTimeEl = document.getElementById('current-time') as HTMLElement;
const cameraFeeds = document.querySelectorAll('.camera-feed');
const scanButton = document.getElementById('scan-button') as HTMLButtonElement;
const loader = document.getElementById('loader') as HTMLElement;
const policeLookoutToggle = document.getElementById('police-lookout') as HTMLInputElement;
const autoPatrolToggle = document.getElementById('auto-patrol') as HTMLInputElement;
const tabs = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// AI Analysis Panel
const aiAssessmentEl = document.getElementById('ai-assessment') as HTMLElement;
const aiObjectsEl = document.getElementById('ai-objects') as HTMLElement;
const aiActionEl = document.getElementById('ai-action') as HTMLElement;

// Timeline Panel
const timelineContent = document.getElementById('timeline-content') as HTMLElement;
const exportTimelineButton = document.getElementById('export-timeline-button') as HTMLButtonElement;

// Log Panel
const terminal = document.getElementById('terminal') as HTMLElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const sendChatButton = document.getElementById('send-chat-button') as HTMLButtonElement;

// Map Panel
const audioVisualizerCanvas = document.getElementById('audio-visualizer') as HTMLCanvasElement;
const radarCanvas = document.getElementById('radar-canvas') as HTMLCanvasElement;
const scanLocationButton = document.getElementById('scan-location-button') as HTMLButtonElement;

// System Panel
const addCameraForm = document.getElementById('add-camera-form') as HTMLFormElement;
const cameraNameInput = document.getElementById('camera-name-input') as HTMLInputElement;
const cameraUrlInput = document.getElementById('camera-url-input') as HTMLInputElement;

// --- State Management ---
interface Camera {
    id: string;
    element: HTMLElement;
    location: string;
    type: 'local' | 'stream' | 'offline';
    streamUrl?: string;
    videoEl?: HTMLVideoElement;
    captureCanvas?: HTMLCanvasElement;
    iframeEl?: HTMLIFrameElement;
    statusEl?: HTMLElement;
    placeholderEl?: HTMLElement;
}

interface AppState {
    isScanning: boolean;
    startTime: Date;
    activeCamId: string;
    aiChat: Chat | null;
    isPoliceLookoutActive: boolean;
    isAutoPatrolActive: boolean;
    autoPatrolIntervalId: number | null;
    patrolIndex: number;
    events: any[];
    cameras: Map<string, Camera>;
    audio: { context: AudioContext | null, analyser: AnalyserNode | null, source: MediaStreamAudioSourceNode | null, dataArray: Uint8Array | null };
}

const state: AppState = {
    isScanning: false,
    startTime: new Date(),
    activeCamId: 'CAM_01_AI',
    aiChat: null,
    isPoliceLookoutActive: false,
    isAutoPatrolActive: false,
    autoPatrolIntervalId: null,
    patrolIndex: 0,
    events: [],
    cameras: new Map(),
    audio: { context: null, analyser: null, source: null, dataArray: null },
};

// --- Gemini AI Initialization ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Core Functions ---
function addLog(type: 'user' | 'ai' | 'system-error' | 'system-info', message: string) {
    if (!terminal) return;
    const timeStr = new Date().toTimeString().split(' ')[0];
    const logLine = document.createElement('div');
    const prefix = type === 'user' ? 'USER: ' : type === 'ai' ? 'SENTINEL: ' : 'SYSTEM: ';
    logLine.className = type === 'user' ? 'user-msg' : type === 'ai' ? 'ai-msg' : '';
    logLine.textContent = `[${timeStr}] ${prefix}${message}`;
    terminal.appendChild(logLine);
    terminal.scrollTop = terminal.scrollHeight;
}

function resetUIScanningState() {
    state.isScanning = false;
    loader.classList.add('hidden');
    scanButton.classList.remove('hidden');
    const activeCam = state.cameras.get(state.activeCamId);
    scanButton.disabled = !activeCam || activeCam.type === 'offline';
}

async function initSystem() {
    addLog('system-info', 'SENTINEL-AI 5.0 Booting...');
    
    // Initialize Cameras
    cameraFeeds.forEach(feedEl => {
        const el = feedEl as HTMLElement;
        const camId = el.dataset.camId!;
        const cam: Camera = {
            id: camId,
            element: el,
            location: el.dataset.location!,
            type: el.dataset.type as any,
            streamUrl: el.dataset.streamUrl,
            statusEl: el.querySelector('.camera-status') as HTMLElement,
            placeholderEl: el.querySelector('.camera-placeholder') as HTMLElement,
        };

        if (cam.type === 'local') {
            cam.videoEl = el.querySelector('video') as HTMLVideoElement;
            cam.captureCanvas = el.querySelector('canvas[id*="capture"]') as HTMLCanvasElement;
        } else if (cam.type === 'stream') {
            cam.iframeEl = el.querySelector('iframe') as HTMLIFrameElement;
            if (cam.iframeEl && cam.streamUrl) {
                const embedUrl = convertYoutubeUrlToEmbed(cam.streamUrl);
                if (embedUrl) cam.iframeEl.src = embedUrl;
            }
        }
        
        state.cameras.set(camId, cam);
        el.addEventListener('click', () => setActiveCamera(camId));
    });

    // Initialize Local Media (Front and Rear Cams)
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');

        if (videoDevices.length > 0) {
            await setupLocalCamera('CAM_01_AI', videoDevices[0].deviceId);
        } else {
            throw new Error("No video devices found.");
        }
        if (videoDevices.length > 1) {
            await setupLocalCamera('CAM_04_AI', videoDevices[1].deviceId);
        }

    } catch (err) {
        addLog('system-error', `CRITICAL: Camera initialization failed. ${err.message}`);
        scanButton.disabled = true;
    }

    // Initialize Audio
    initAudio();

    // Initialize AI
    const systemInstruction = "You are SENTINEL-AI, a tactical analysis AI for a surveillance system. Be concise, professional, and tactical. Your primary function is to analyze visual data and provide actionable intelligence.";
    state.aiChat = ai.chats.create({ model: 'gemini-2.5-flash', config: { systemInstruction } });
    addLog('system-info', 'AI Core Synced. Ready for command.');

    loadSettings();
    setActiveCamera('CAM_01_AI');
    drawRadar(); // Initial radar draw
}


async function setupLocalCamera(camId: string, deviceId: string) {
    const cam = state.cameras.get(camId);
    if (!cam || !cam.videoEl || cam.type !== 'local') return;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
        cam.videoEl.srcObject = stream;
        cam.videoEl.onloadedmetadata = () => {
            if (cam.captureCanvas) {
                cam.captureCanvas.width = cam.videoEl!.videoWidth;
                cam.captureCanvas.height = cam.videoEl!.videoHeight;
            }
        };
        if (cam.placeholderEl) cam.placeholderEl.classList.add('hidden');
        if (cam.statusEl) {
            cam.statusEl.textContent = 'LIVE';
            cam.statusEl.classList.add('ai-active');
        }
        addLog('system-info', `${camId} feed initialized.`);
    } catch (err) {
        addLog('system-error', `Failed to initialize ${camId}: ${err.message}`);
        if(cam.statusEl) {
            cam.statusEl.textContent = 'ERROR';
            cam.statusEl.classList.remove('ai-active');
            cam.statusEl.classList.add('offline');
        }
    }
}

async function callGeminiAPI(base64ImageData: string, textPrompt: string) {
    addLog('ai', 'Analyzing visual data...');
    const schema = {
        type: Type.OBJECT,
        properties: {
            assessment: { type: Type.STRING, description: 'A brief tactical summary.' },
            action: { type: Type.STRING, description: 'A recommended action.' },
            objects: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: { name: { type: Type.STRING }, confidence: { type: Type.NUMBER }, box: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "Normalized [ymin, xmin, ymax, xmax]" } },
                    required: ["name", "confidence", "box"],
                }
            }
        },
        required: ["assessment", "action", "objects"],
    };
    try {
        const imagePart = { inlineData: { mimeType: "image/png", data: base64ImageData } };
        const textPart = { text: textPrompt };
        const response = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: { parts: [imagePart, textPart] }, config: { responseMimeType: 'application/json', responseSchema: schema } });
        const analysis = JSON.parse(response.text);
        
        updateAnalysisPanel(analysis);
        addLog('ai', analysis.assessment);
        logEvent('visual', analysis);

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message.split('\n')[0] : 'Unknown API error';
        addLog('system-error', `Gemini Analysis Failed: ${errorMessage}`);
        updateAnalysisPanel({ assessment: "Scan failed.", action: "Retry", objects: [] });
    } finally {
        resetUIScanningState();
    }
}


async function handleScan() {
    const activeCam = state.cameras.get(state.activeCamId);
    if (!activeCam || activeCam.type === 'offline' || state.isScanning) return;
    
    state.isScanning = true;
    scanButton.classList.add('hidden');
    loader.classList.remove('hidden');

    if (activeCam.type === 'local' && activeCam.videoEl && activeCam.videoEl.srcObject && activeCam.captureCanvas) {
        addLog('system-info', `Performing visual scan on ${activeCam.id}...`);
        const context = activeCam.captureCanvas.getContext('2d');
        if (!context) { addLog('system-error', 'Canvas context not available.'); resetUIScanningState(); return; }
        context.drawImage(activeCam.videoEl, 0, 0, activeCam.captureCanvas.width, activeCam.captureCanvas.height);
        const base64ImageData = activeCam.captureCanvas.toDataURL('image/png').split(',')[1];
        let prompt = "Analyze this security camera image. Identify objects, assess the situation, and suggest an action. Return bounding boxes for all objects.";
        if (state.isPoliceLookoutActive) prompt = "HIGH ALERT: Analyze this image for any signs of law enforcement (vehicles, personnel, uniforms). Provide standard object analysis as well.";
        await callGeminiAPI(base64ImageData, prompt);
    } else if (activeCam.type === 'stream') {
        addLog('system-info', `Performing situational analysis for ${activeCam.location}...`);
        const prompt = `Provide a brief, tactical situational analysis for a public camera at this location: ${activeCam.location}. Focus on potential security concerns, traffic flow, and crowd levels.`;
        try {
            if (state.aiChat) {
                const response = await state.aiChat.sendMessage({ message: prompt });
                const analysis = { assessment: response.text, action: "Monitor", objects: [] };
                updateAnalysisPanel(analysis);
                addLog('ai', response.text);
                logEvent('situational', analysis);
            }
        } catch (error) {
            addLog('system-error', 'Situational analysis failed.');
            updateAnalysisPanel({ assessment: "Analysis failed.", action: "Retry", objects: [] });
        } finally {
            resetUIScanningState();
        }
    } else {
        addLog('system-info', `Cannot scan ${activeCam.id}. Feed is inactive or offline.`);
        resetUIScanningState();
    }
}

async function handleSendChat() {
    const message = chatInput.value.trim();
    if (!message || !state.aiChat) return;
    addLog('user', message);
    chatInput.value = '';
    chatInput.disabled = true;
    sendChatButton.disabled = true;
    try {
        const response = await state.aiChat.sendMessage({ message });
        addLog('ai', response.text);
    } catch (error) { addLog('system-error', "Failed to get response from AI."); } finally {
        chatInput.disabled = false; sendChatButton.disabled = false; chatInput.focus();
    }
}

// --- UI and View Functions ---
function updateTime() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US');
    currentTimeEl.textContent = `Date: ${dateStr} | Time: ${timeStr}`;

    const diff = now.getTime() - state.startTime.getTime();
    const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
    const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
    const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
    uptimeEl.textContent = `${h}:${m}:${s}`;
}

function getEmojiForObject(name: string): string {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('car') || lowerName.includes('vehicle')) return '🚗';
    if (lowerName.includes('person') || lowerName.includes('man') || lowerName.includes('woman')) return '🚶';
    if (lowerName.includes('truck')) return '🚚';
    if (lowerName.includes('police')) return '🚓';
    if (lowerName.includes('bus')) return '🚌';
    if (lowerName.includes('bicycle')) return '🚲';
    return '👁️';
}

function updateAnalysisPanel(data: any) {
    aiAssessmentEl.textContent = data.assessment || "No assessment.";
    aiActionEl.textContent = data.action || "None";
    aiObjectsEl.innerHTML = '';
    if (data.objects && data.objects.length > 0) {
        data.objects.forEach((obj: any) => {
            const li = document.createElement('li');
            const confidence = (obj.confidence * 100).toFixed(1);
            const emoji = getEmojiForObject(obj.name);
            li.innerHTML = `${emoji} ${obj.name} <span class="confidence">(${confidence}%)</span>`;
            aiObjectsEl.appendChild(li);
        });
    } else { aiObjectsEl.innerHTML = '<li>None detected</li>'; }
}

function drawBoundingBoxesOnCanvas(objects: any[], targetCanvas: HTMLCanvasElement, sourceVideo: HTMLVideoElement) {
    const ctx = targetCanvas.getContext('2d');
    if (!ctx || !objects) return;
    targetCanvas.width = sourceVideo.videoWidth;
    targetCanvas.height = sourceVideo.videoHeight;
    ctx.drawImage(sourceVideo, 0, 0, targetCanvas.width, targetCanvas.height);
    
    objects.forEach(obj => {
        if (!obj.box || obj.box.length !== 4) return;
        const [ymin, xmin, ymax, xmax] = obj.box;
        const left = xmin * targetCanvas.width;
        const top = ymin * targetCanvas.height;
        const width = (xmax - xmin) * targetCanvas.width;
        const height = (ymax - ymin) * targetCanvas.height;
        ctx.strokeStyle = '#4d94ff'; ctx.lineWidth = 2; ctx.strokeRect(left, top, width, height);
        ctx.fillStyle = '#4d94ff'; ctx.font = '12px Courier New';
        ctx.fillText(`${obj.name} (${(obj.confidence * 100).toFixed(0)}%)`, left, top > 12 ? top - 2 : top + 12);
    });
    return targetCanvas.toDataURL('image/jpeg', 0.8);
}

function convertYoutubeUrlToEmbed(url: string) {
    let videoId = '';
    try {
        const urlObj = new URL(url);
        if (urlObj.hostname === 'youtu.be') { videoId = urlObj.pathname.slice(1); } 
        else if (urlObj.hostname.includes('youtube.com')) {
            videoId = urlObj.pathname.includes('/live/') ? urlObj.pathname.split('/live/')[1] : urlObj.searchParams.get('v') || '';
        }
    } catch (e) { /* Invalid URL */ }
    return videoId ? `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&controls=0&modestbranding=1&loop=1&playlist=${videoId}` : null;
}

function setActiveCamera(camId: string) {
    const cam = state.cameras.get(camId);
    if (!cam) return;
    
    state.activeCamId = camId;
    state.cameras.forEach(c => c.element.classList.remove('active'));
    cam.element.classList.add('active');
    
    scanButton.disabled = cam.type === 'offline' || (cam.type === 'local' && !cam.videoEl?.srcObject) || state.isScanning;
}

function handleExportTimeline() {
    let html = `<html><head><title>SENTINEL-AI Report</title><style>body{font-family:monospace;background:#0d0221;color:#e0e0e0;padding:20px}h1{color:#4d94ff}.event{border:1px solid #4d94ff;margin-bottom:20px;padding:15px}h2{color:#00ffff}p{margin:5px 0}img{max-width:100%;border:1px solid #00ffff;margin-top:10px}</style></head><body><h1>SENTINEL-AI Event Report</h1><h3>Generated: ${new Date().toLocaleString()}</h3><hr>`;
    state.events.forEach(event => {
        html += `<div class="event"><h2>${event.assessment}</h2><p><strong>Timestamp:</strong> ${event.timestamp.toLocaleString()}</p><p><strong>Location:</strong> ${event.location}</p>`;
        if(event.snapshot) {
            html += `<img src="${event.snapshot}" alt="Snapshot/Report">`;
        } else if (event.report) {
             html += `<p><strong>Report:</strong> ${event.report}</p>`;
        }
        html += '</div>';
    });
    html += '</body></html>';

    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sentinel-events.html';
    a.click();
    URL.revokeObjectURL(url);
    addLog('system-info', 'Event timeline exported.');
}

function loadSettings() {
    const lookout = localStorage.getItem('sentinel-lookout') === 'true';
    policeLookoutToggle.checked = lookout;
    state.isPoliceLookoutActive = lookout;
    cameraFeeds.forEach(feed => feed.classList.toggle('lookout-active', lookout));

    const patrol = localStorage.getItem('sentinel-patrol') === 'true';
    autoPatrolToggle.checked = patrol;
    if(patrol) autoPatrolToggle.dispatchEvent(new Event('change'));
}

function setupEventListeners() {
    scanButton.addEventListener('click', handleScan);
    sendChatButton.addEventListener('click', handleSendChat);
    chatInput.addEventListener('keydown', (e) => e.key === 'Enter' && handleSendChat());
    exportTimelineButton.addEventListener('click', handleExportTimeline);
    scanLocationButton.addEventListener('click', handleLocationScan);
    addCameraForm.addEventListener('submit', handleAddCamera);

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.getAttribute('data-tab');
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            tabPanes.forEach(pane => {
                const htmlPane = pane as HTMLElement;
                htmlPane.classList.toggle('active', htmlPane.id === `${target}-pane`);
                // Special handling for map pane display
                if (htmlPane.id === 'map-pane') {
                    htmlPane.style.display = htmlPane.classList.contains('active') ? 'flex' : 'none';
                }
            });
        });
    });
    
    policeLookoutToggle.addEventListener('change', () => {
        state.isPoliceLookoutActive = policeLookoutToggle.checked;
        localStorage.setItem('sentinel-lookout', String(state.isPoliceLookoutActive));
        cameraFeeds.forEach(feed => feed.classList.toggle('lookout-active', state.isPoliceLookoutActive));
        addLog('system-info', `Police Lookout ${state.isPoliceLookoutActive ? 'ENGAGED' : 'DISENGAGED'}.`);
    });

    autoPatrolToggle.addEventListener('change', () => {
        state.isAutoPatrolActive = autoPatrolToggle.checked;
        localStorage.setItem('sentinel-patrol', String(state.isAutoPatrolActive));
        addLog('system-info', `System Patrol ${state.isAutoPatrolActive ? 'ACTIVATED' : 'DEACTIVATED'}.`);
        if (state.isAutoPatrolActive && !state.autoPatrolIntervalId) {
            runPatrolCycle(); // Start immediately
            state.autoPatrolIntervalId = window.setInterval(runPatrolCycle, 30000);
        } else if (!state.isAutoPatrolActive && state.autoPatrolIntervalId) {
            clearInterval(state.autoPatrolIntervalId);
            state.autoPatrolIntervalId = null;
        }
    });
}

function runPatrolCycle() {
    const activeCameras = Array.from(state.cameras.values()).filter(cam => cam.type !== 'offline');
    if (activeCameras.length === 0) {
        addLog('system-info', 'Patrol cycle skipped: No active cameras.');
        return;
    }
    state.patrolIndex = (state.patrolIndex + 1) % activeCameras.length;
    const nextCam = activeCameras[state.patrolIndex];
    addLog('system-info', `Patrol cycling to ${nextCam.id}...`);
    setActiveCamera(nextCam.id);
    setTimeout(() => handleScan(), 500);
}


function logEvent(type: 'visual' | 'situational', analysis: any) {
    const activeCam = state.cameras.get(state.activeCamId);
    if(!activeCam) return;
    
    const event: any = {
        id: Date.now(),
        timestamp: new Date(),
        assessment: analysis.assessment,
        type: type,
        location: activeCam.location,
    };

    if (type === 'visual' && activeCam.type === 'local' && activeCam.videoEl) {
         if (!analysis.objects || analysis.objects.length === 0) return;
        const snapshotCanvas = document.createElement('canvas');
        event.snapshot = drawBoundingBoxesOnCanvas(analysis.objects, snapshotCanvas, activeCam.videoEl);
    } else if (type === 'situational') {
        event.report = analysis.assessment;
        event.snapshot = createSituationalReportImage({ location: activeCam.location, report: analysis.assessment });
    }
    
    state.events.unshift(event);
    if (state.events.length > 50) state.events.pop();
    updateTimeline();
}

function updateTimeline() {
    timelineContent.innerHTML = '';
    state.events.forEach(event => {
        const div = document.createElement('div');
        div.className = 'timeline-event';
        div.innerHTML = `<span>${event.assessment}</span><small>${event.timestamp.toLocaleTimeString()}</small>`;
        timelineContent.appendChild(div);
    });
}

// --- Audio Visualizer ---
async function initAudio() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.audio.context = new AudioContext();
        state.audio.analyser = state.audio.context.createAnalyser();
        state.audio.source = state.audio.context.createMediaStreamSource(stream);
        state.audio.source.connect(state.audio.analyser);
        state.audio.analyser.fftSize = 256;
        const bufferLength = state.audio.analyser.frequencyBinCount;
        state.audio.dataArray = new Uint8Array(bufferLength);
        addLog('system-info', 'Audio monitor activated.');
        drawVisualizer();
    } catch (err) {
        addLog('system-error', 'Audio monitor failed to initialize.');
    }
}

function drawVisualizer() {
    requestAnimationFrame(drawVisualizer);
    if (!state.audio.analyser || !state.audio.dataArray || !audioVisualizerCanvas) return;
    const canvasCtx = audioVisualizerCanvas.getContext('2d');
    if (!canvasCtx) return;

    state.audio.analyser.getByteFrequencyData(state.audio.dataArray);
    
    const { width, height } = audioVisualizerCanvas;
    canvasCtx.clearRect(0, 0, width, height);

    const barWidth = (width / state.audio.dataArray.length) * 2.5;
    let x = 0;
    for (let i = 0; i < state.audio.dataArray.length; i++) {
        const barHeight = state.audio.dataArray[i] / 2;
        canvasCtx.fillStyle = `rgba(0, 255, 255, ${barHeight / 150})`;
        canvasCtx.fillRect(x, height - barHeight / 2, barWidth, barHeight);
        x += barWidth + 1;
    }
}

// --- Tactical Map ---
function drawRadar() {
    const ctx = radarCanvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = radarCanvas;
    const centerX = width / 2;
    const centerY = height / 2;
    
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(0, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    [0.2, 0.4, 0.6, 0.8].forEach(r => {
        ctx.beginPath();
        ctx.arc(centerX, centerY, (height/2) * r, 0, 2 * Math.PI);
        ctx.stroke();
    });
}

function plotOnRadar(points: {name: string, distance: number, angle: number}[]) {
    const ctx = radarCanvas.getContext('2d');
    if (!ctx) return;
    drawRadar(); // Redraw base
    const { width, height } = radarCanvas;
    const centerX = width / 2;
    const centerY = height / 2;
    
    points.forEach(point => {
        const radius = (point.distance / 100) * (height / 2); // Assuming max distance 100
        const x = centerX + radius * Math.cos(point.angle);
        const y = centerY + radius * Math.sin(point.angle);
        ctx.fillStyle = '#4d94ff';
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, 2 * Math.PI);
        ctx.fill();
    });
}

function handleLocationScan() {
    addLog('system-info', 'Scanning local area for points of interest...');
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            const { latitude, longitude } = position.coords;
            addLog('system-info', `Location acquired: ${latitude.toFixed(4)}, ${longitude.toFixed(4)}`);
            if (state.aiChat) {
                const prompt = `Identify 3-5 key public points of interest (like intersections, parks, landmarks) near latitude ${latitude}, longitude ${longitude}. Be very brief.`;
                const response = await state.aiChat.sendMessage({ message: prompt });
                addLog('ai', `POI Analysis: ${response.text}`);
                const mockPoints = Array.from({length: 4}, () => ({ name: 'POI', distance: Math.random() * 80 + 10, angle: Math.random() * 2 * Math.PI }));
                plotOnRadar(mockPoints);
            }
        },
        () => { addLog('system-error', 'Geolocation access denied by user.'); },
        { enableHighAccuracy: true }
    );
}

// --- New Functions ---
function handleAddCamera(e: Event) {
    e.preventDefault();
    const name = cameraNameInput.value.trim();
    const url = cameraUrlInput.value.trim();
    if (!name || !url) {
        addLog('system-error', 'Camera Name and URL are required.');
        return;
    }

    const embedUrl = convertYoutubeUrlToEmbed(url);
    if (!embedUrl) {
        addLog('system-error', 'Invalid YouTube URL provided.');
        return;
    }

    // Target CAM_04 for replacement
    const camToUpdate = state.cameras.get('CAM_04_AI');
    if (!camToUpdate || !camToUpdate.iframeEl) {
        addLog('system-error', 'Target camera slot (CAM_04) not found or invalid.');
        return;
    }

    // Stop local video stream if it exists
    if (camToUpdate.type === 'local' && camToUpdate.videoEl && camToUpdate.videoEl.srcObject) {
        (camToUpdate.videoEl.srcObject as MediaStream).getTracks().forEach(track => track.stop());
    }

    // Update state
    camToUpdate.type = 'stream';
    camToUpdate.location = name;
    camToUpdate.streamUrl = url;

    // Update DOM
    const camIdEl = camToUpdate.element.querySelector('.camera-id') as HTMLElement;
    if (camIdEl) camIdEl.textContent = `CAM_04 - ${name}`;
    if (camToUpdate.statusEl) {
        camToUpdate.statusEl.textContent = 'STREAM';
        camToUpdate.statusEl.className = 'camera-status streaming';
    }
    if (camToUpdate.videoEl) camToUpdate.videoEl.style.display = 'none';
    if (camToUpdate.placeholderEl) camToUpdate.placeholderEl.classList.add('hidden');
    
    camToUpdate.iframeEl.src = embedUrl;
    camToUpdate.iframeEl.style.display = 'block';

    addLog('system-info', `Camera feed for ${name} added to CAM_04.`);
    addCameraForm.reset();
}

function createSituationalReportImage(eventData: { location: string, report: string }): string {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 450;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    // Background
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Border
    ctx.strokeStyle = '#4d94ff';
    ctx.lineWidth = 4;
    ctx.strokeRect(0, 0, canvas.width, canvas.height);
    // Header
    ctx.fillStyle = '#e0e0e0';
    ctx.font = 'bold 24px "Courier New", monospace';
    ctx.fillText(`// SITUATIONAL REPORT //`, 30, 50);
    ctx.font = '18px "Courier New", monospace';
    ctx.fillText(`LOCATION: ${eventData.location}`, 30, 80);
    // Report Text
    ctx.fillStyle = '#00ffff';
    ctx.font = '16px "Courier New", monospace';
    const reportLines = wrapText(ctx, eventData.report, canvas.width - 60);
    reportLines.forEach((line, index) => {
        ctx.fillText(line, 30, 120 + (index * 22));
    });

    return canvas.toDataURL('image/jpeg', 0.9);
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = words[0] || '';

    for (let i = 1; i < words.length; i++) {
        const word = words[i];
        const width = context.measureText(currentLine + " " + word).width;
        if (width < maxWidth) {
            currentLine += " " + word;
        } else {
            lines.push(currentLine);
            currentLine = word;
        }
    }
    lines.push(currentLine);
    return lines;
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    initSystem();
    setupEventListeners();
    setInterval(updateTime, 1000);
    updateTime();
});
