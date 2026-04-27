/**
 * Smart Classroom Monitoring System
 * Real-Time Data from Embedded CSV with Live Timestamps
 */

// ---------------- MQTT SETUP ----------------

// Connect to MQTT broker (WebSocket version)
const client = mqtt.connect("wss://broker.hivemq.com:8884/mqtt");

// --- 🎛️ ADMIN CONTROL CASE DATA ---
const caseData = {
    1: { pir: 0, ldr: 800, distance: 250, description: "Nobody in class, bright" },
    2: { pir: 0, ldr: 50, distance: 250, description: "Nobody in class, dark" },
    3: { pir: 1, ldr: 800, distance: 75, description: "Someone enters, bright" },
    4: { pir: 1, ldr: 50, distance: 75, description: "Someone enters, dark" },
    5: { pir: 1, ldr: 500, distance: 60, description: "Person inside, any light" },
    6: { pir: 0, ldr: 50, distance: 250, description: "Person leaves, dark" },
    7: { pir: 0, ldr: 800, distance: 250, description: "Person leaves, bright" },
    8: { pir: 0, ldr: 400, distance: 280, description: "No motion for long time" }
};

client.on("connect", () => {
    console.log("✅ Connected to MQTT from Website");

    // Subscribe to ESP32 topics
    client.subscribe("smartroom/pir");
    client.subscribe("smartroom/ldr");
    client.subscribe("smartroom/distance");
    
    // Subscribe to admin control topic
    client.subscribe("smartroom/control");
});

client.on("message", (topic, message) => {
    const value = message.toString();
    console.log("📩 MQTT Data:", topic, value);

    if (topic === "smartroom/control") {
        handleAdminControlMessage(value);
    } else {
        updateRoom101FromMQTT(topic, value);
    }
});

// --- �️ ADMIN CONTROL MESSAGE HANDLER ---
function handleAdminControlMessage(message) {
    try {
        const data = JSON.parse(message);
        console.log("🎛️ Admin Control Message:", data);

        if (data.action === "ADMIN_OVERRIDE") {
            // Apply admin override from remote control
            const overrideData = {
                active: true,
                case: data.case,
                data: caseData[data.case], // Use the same case data as admin panel
                timestamp: Date.now(),
                source: 'mqtt'
            };

            localStorage.setItem('adminOverride', JSON.stringify(overrideData));
            applyAdminCase(overrideData);

            console.log(`🎛️ Remote Admin Override Applied: Case ${data.case} from ${data.room}`);

            // Update UI to show manual mode
            updateThingSpeakFetchPanel('Manual override active (Remote)', 'manual');

        } else if (data.action === "RESUME_AUTO") {
            // Clear admin override and resume auto mode
            localStorage.removeItem('adminOverride');
            console.log("🎛️ Remote Resume Auto Mode");

            // Resume normal operation
            updateThingSpeakFetchPanel('Auto mode resumed (Remote)', 'idle');
            fetchThingSpeakData();
        }

    } catch (error) {
        console.error("❌ Error parsing admin control message:", error);
    }
}

// --- �🎯 CSV DATA EMBEDDED (Your sensor data) ---
const CSV_CONFIG = {
    realTimeRoom: 'Room 101',
    updateInterval: 5000, // 5 seconds (faster updates!)
};

const THINGSPEAK_CHANNEL_ID = "3356492";
const THINGSPEAK_READ_API_KEY = "KVJGYMEUKTEBPSE7"; // Set this if your ThingSpeak channel is private
const THINGSPEAK_URL = `https://api.thingspeak.com/channels/${THINGSPEAK_CHANNEL_ID}/feeds.json?results=1${THINGSPEAK_READ_API_KEY ? `&api_key=${THINGSPEAK_READ_API_KEY}` : ""}`;
const EWS_STORAGE_KEY = 'smartClassroomEwsStatsV1';
const EWS_FLAG_THRESHOLD = 30;
const EWS_SESSION_LIMIT = 20;
let ewsTrendChartInstance = null;
let ewsTrendLastRenderKey = '';

// Load CSV data from file
let csvData = [];
let csvLoaded = false;

async function loadCSVData() {
    try {
        const response = await fetch('feed_thingspeak_IST.csv');
        const text = await response.text();
        const lines = text.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',');
        
        csvData = lines.slice(1).map(line => {
            const values = line.split(',');
            return {
                created_at: values[0],
                pir: parseInt(values[1]) || 0,
                ldr: parseInt(values[2]) || 0,
                distance: parseInt(values[3]) || 0,
                led: parseInt(values[4]) || 0,
                ews: parseFloat(values[5]) || 0
            };
        });
        
        csvLoaded = true;
        console.log(`✅ Loaded ${csvData.length} entries from feed_thingspeak_IST.csv`);
    } catch (error) {
        console.error('❌ Failed to load CSV:', error);
        // Fallback to embedded data if file fails
        csvData = [
            {pir: 0, ldr: 823, distance: 131},
            // ... keep some fallback data
        ];
    }
}

let currentDataIndex = 0;

// Get current time
function getCurrentHour() {
    return new Date().getHours();
}

// Determine if it's day time (8 AM - 6 PM)
function isDayTime() {
    const hour = getCurrentHour();
    return hour >= 8 && hour < 18;
}

// Smart lighting logic
function calculateLightStatus(pir, ldr, distance) {
    const ldrStatus = ldr < 300 ? 0 : 1;

    if (isDayTime()) {
        if (pir === 1) {
            return {
                lightStatus: 'ON',
                peoplePresent: 'YES',
                showDistance: true
            };
        } else {
            return {
                lightStatus: 'OFF',
                peoplePresent: 'NO',
                showDistance: false
            };
        }
    } else {
        if (ldrStatus === 0 && pir === 1) {
            return {
                lightStatus: 'ON',
                peoplePresent: 'YES',
                showDistance: true
            };
        } else {
            return {
                lightStatus: 'OFF',
                peoplePresent: pir === 1 ? 'YES' : 'NO',
                showDistance: false
            };
        }
    }
}

function updateRoom101FromMQTT(topic, value) {
    const room = roomData.find(r => r.room === "Room 101");

    if (!room) return;

    const previousDistance = room.distance;

    if (topic === "smartroom/pir") {
        room.pir = parseInt(value);
    }

    if (topic === "smartroom/ldr") {
        room.ldr = parseInt(value);
    }

    if (topic === "smartroom/distance") {
        room.distance = parseInt(value);
    }

    // Apply logic again
    const logic = calculateLightStatus(room.pir, room.ldr, room.distance);
    const presence = evaluateRoom101PresenceState(room.pir, room.distance, previousDistance);

    room.lightStatus = room.ledState || logic.lightStatus;
    room.peoplePresent = presence.present;
    room.peopleStatusLabel = presence.label;

    const now = new Date();
    room.updateTime = now.toLocaleTimeString();
    syncEwsAfterStateMutation(room);

    applyFilter(); // refresh UI
}

function normalizeLedState(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === '') {
        return null;
    }

    const text = String(rawValue).trim().toUpperCase();

    if (text === '1' || text === 'ON' || text === 'HIGH' || text === 'TRUE') {
        return 'ON';
    }

    if (text === '0' || text === 'OFF' || text === 'LOW' || text === 'FALSE') {
        return 'OFF';
    }

    const numeric = Number.parseInt(text, 10);
    if (!Number.isNaN(numeric)) {
        return numeric === 1 ? 'ON' : 'OFF';
    }

    return null;
}

function evaluateRoom101PresenceState(pir, distance, previousDistance) {
    const stableThresholdCm = 5;

    if (pir === 1 && distance < 50) {
        return { present: 'YES', label: 'ENTERING' };
    }

    if (pir === 1 && distance > 150) {
        return { present: 'YES', label: 'INSIDE/MOVING' };
    }

    if (pir === 1) {
        return { present: 'YES', label: 'MOTION DETECTED' };
    }

    const hasPrevious = typeof previousDistance === 'number' && !Number.isNaN(previousDistance);
    const isStable = hasPrevious && Math.abs(distance - previousDistance) <= stableThresholdCm;

    if (isStable) {
        return { present: 'NO', label: 'STATIONARY/LEFT' };
    }

    return { present: 'NO', label: 'NO MOTION' };
}

function sendRoomCommand(room, command) {

    if (room !== "Room 101") {
        alert("⚠️ Control only available for Room 101");
        return;
    }

    if (client.connected) {
        client.publish("smartroom/control", command);
        console.log(`📤 ${room} → ${command}`);
    } else {
        console.log("❌ MQTT not connected");
    }
}

function updateThingSpeakFetchPanel(status, statusClass, sourceTime) {
    const statusElement = document.getElementById('tsFetchStatus');
    const fetchTimeElement = document.getElementById('tsFetchTime');
    const sourceTimeElement = document.getElementById('tsSourceTime');
    const now = new Date();

    if (statusElement) {
        statusElement.textContent = status;
        statusElement.className = `ts-status ${statusClass}`;
    }

    if (fetchTimeElement) {
        fetchTimeElement.textContent = `Fetched at: ${now.toLocaleTimeString()}`;
    }

    if (sourceTimeElement) {
        sourceTimeElement.textContent = sourceTime ? `Feed time: ${new Date(sourceTime).toLocaleString()}` : 'Feed time: --';
    }
}

async function fetchThingSpeakData() {
    const override = getActiveAdminOverride();
    if (override) {
        updateThingSpeakFetchPanel('Manual override active', 'manual');
        console.log('⚠️ ThingSpeak fetch skipped while admin override is active');
        applyAdminCase(override);
        return;
    }

    try {
        updateThingSpeakFetchPanel('Fetching...', 'loading');

        const response = await fetch(THINGSPEAK_URL, { cache: "no-store" });

        if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`HTTP ${response.status} - ${errorBody}`);
        }

        const data = await response.json();

        if (!data.feeds || data.feeds.length === 0) {
            console.warn("ThingSpeak returned no feeds. Check channel visibility/read API key.");
            updateThingSpeakFetchPanel('No feed data', 'error');
            return;
        }

        const feed = data.feeds[0];

        const pir = Number.parseInt(feed.field1, 10);
        const ldr = Number.parseInt(feed.field2, 10);
        const distance = Number.parseInt(feed.field3, 10);
        const ledState = normalizeLedState(feed.field4);

        if (Number.isNaN(pir) || Number.isNaN(ldr) || Number.isNaN(distance)) {
            console.warn("ThingSpeak feed fields are invalid:", feed);
            updateThingSpeakFetchPanel('Invalid feed fields', 'error', feed.created_at);
            return;
        }

        console.log("ThingSpeak Data:", pir, ldr, distance, ledState);
        updateThingSpeakFetchPanel(`OK (Entry ${feed.entry_id ?? '-'})`, 'success', feed.created_at);

        updateRoom101(pir, ldr, distance, ledState, feed.created_at);

    } catch (error) {
        console.error("Error fetching ThingSpeak:", error);
        updateThingSpeakFetchPanel('Fetch failed', 'error');
    }
}

function updateRoom101(pir, ldr, distance, ledState, sourceTimestamp) {
    const room = roomData.find(r => r.room === "Room 101");

    if (!room) return;

    const previousDistance = room.distance;

    room.pir = pir;
    room.ldr = ldr;
    room.distance = distance;

    const logic = calculateLightStatus(pir, ldr, distance);
    const presence = evaluateRoom101PresenceState(pir, distance, previousDistance);

    room.ledState = ledState;
    room.lightStatus = ledState || logic.lightStatus;
    room.peoplePresent = presence.present;
    room.peopleStatusLabel = presence.label;

    const now = new Date();
    room.updateTime = now.toLocaleTimeString();
    room.lastUpdate = now.toLocaleDateString();

    if (sourceTimestamp) {
        trackRoom101EwsFromThingSpeak(room, sourceTimestamp);
    } else {
        syncEwsAfterStateMutation(room);
    }

    applyFilter();
    if (document.getElementById('analyticsView')?.style.display !== 'none') {
        updateAnalytics();
    }
}

function createDefaultEwsStats(nowMs) {
    return {
        totalLightOnMs: 0,
        wasteMs: 0,
        lastTrackedAt: nowMs,
        currentSessionStartMs: null,
        currentSessionLightOnMs: 0,
        currentSessionWasteMs: 0,
        sessions: []
    };
}

function ensureEwsState(room) {
    const nowMs = Date.now();

    if (!room.ewsStats) {
        room.ewsStats = createDefaultEwsStats(nowMs);
    }

    if (!Array.isArray(room.ewsStats.sessions)) {
        room.ewsStats.sessions = [];
    }

    if (typeof room.ews !== 'number' || Number.isNaN(room.ews)) {
        room.ews = 0;
    }

    return room.ewsStats;
}

function getRoomEwsPercent(room) {
    const stats = ensureEwsState(room);

    if (stats.totalLightOnMs <= 0) {
        return 0;
    }

    return Number(((stats.wasteMs / stats.totalLightOnMs) * 100).toFixed(1));
}

function getEwsLevel(ewsValue) {
    if (ewsValue > EWS_FLAG_THRESHOLD) return 'wasteful';
    if (ewsValue >= 20) return 'moderate';
    return 'efficient';
}

function finalizeEwsSession(room, sessionEndMs) {
    const stats = ensureEwsState(room);

    if (stats.currentSessionStartMs === null || stats.currentSessionLightOnMs <= 0) {
        stats.currentSessionStartMs = null;
        stats.currentSessionLightOnMs = 0;
        stats.currentSessionWasteMs = 0;
        return;
    }

    const sessionEws = stats.currentSessionLightOnMs > 0
        ? Number(((stats.currentSessionWasteMs / stats.currentSessionLightOnMs) * 100).toFixed(1))
        : 0;

    stats.sessions.push({
        startTime: new Date(stats.currentSessionStartMs).toISOString(),
        endTime: new Date(sessionEndMs).toISOString(),
        durationSec: Math.round((sessionEndMs - stats.currentSessionStartMs) / 1000),
        lightOnSec: Math.round(stats.currentSessionLightOnMs / 1000),
        wasteSec: Math.round(stats.currentSessionWasteMs / 1000),
        ews: sessionEws,
        sourceTimestamp: room.lastThingSpeakTimestamp || null
    });

    if (stats.sessions.length > EWS_SESSION_LIMIT) {
        stats.sessions = stats.sessions.slice(-EWS_SESSION_LIMIT);
    }

    stats.currentSessionStartMs = null;
    stats.currentSessionLightOnMs = 0;
    stats.currentSessionWasteMs = 0;
}

function trackEwsForRoom(room, nowMs = Date.now()) {
    const stats = ensureEwsState(room);

    if (nowMs < stats.lastTrackedAt) {
        stats.lastTrackedAt = nowMs;
    }

    const elapsedMs = Math.max(0, nowMs - stats.lastTrackedAt);
    const lightOn = room.lightStatus === 'ON';
    const noMotion = room.peoplePresent === 'NO';

    if (lightOn) {
        if (stats.currentSessionStartMs === null) {
            stats.currentSessionStartMs = stats.lastTrackedAt;
        }

        stats.totalLightOnMs += elapsedMs;
        stats.currentSessionLightOnMs += elapsedMs;

        if (noMotion) {
            stats.wasteMs += elapsedMs;
            stats.currentSessionWasteMs += elapsedMs;
        }
    } else if (stats.currentSessionStartMs !== null) {
        finalizeEwsSession(room, nowMs);
    }

    stats.lastTrackedAt = nowMs;

    room.ews = getRoomEwsPercent(room);
    room.ewsLevel = getEwsLevel(room.ews);
    room.isWasteful = room.ews > EWS_FLAG_THRESHOLD;
}

function trackRoom101EwsFromThingSpeak(room, sourceTimestamp) {
    const stats = ensureEwsState(room);
    const currentTsMs = Date.parse(sourceTimestamp);

    if (Number.isNaN(currentTsMs)) {
        syncEwsAfterStateMutation(room, sourceTimestamp);
        return;
    }

    const previousTsMs = room.lastThingSpeakTimestampMs;

    if (typeof previousTsMs !== 'number' || Number.isNaN(previousTsMs) || currentTsMs <= previousTsMs) {
        room.lastThingSpeakTimestamp = sourceTimestamp;
        room.lastThingSpeakTimestampMs = currentTsMs;
        stats.lastTrackedAt = currentTsMs;

        if (room.lightStatus === 'ON' && stats.currentSessionStartMs === null) {
            stats.currentSessionStartMs = currentTsMs;
        }

        if (room.lightStatus !== 'ON' && stats.currentSessionStartMs !== null) {
            finalizeEwsSession(room, currentTsMs);
        }

        room.ews = getRoomEwsPercent(room);
        room.ewsLevel = getEwsLevel(room.ews);
        room.isWasteful = room.ews > EWS_FLAG_THRESHOLD;
        saveEwsState();
        return;
    }

    const elapsedMs = Math.max(0, currentTsMs - previousTsMs);
    const lightOn = room.lightStatus === 'ON';
    const noMotion = room.peoplePresent === 'NO';

    if (lightOn) {
        if (stats.currentSessionStartMs === null) {
            stats.currentSessionStartMs = previousTsMs;
        }

        stats.totalLightOnMs += elapsedMs;
        stats.currentSessionLightOnMs += elapsedMs;

        if (noMotion) {
            stats.wasteMs += elapsedMs;
            stats.currentSessionWasteMs += elapsedMs;
        }
    } else if (stats.currentSessionStartMs !== null) {
        finalizeEwsSession(room, currentTsMs);
    }

    stats.lastTrackedAt = currentTsMs;
    room.lastThingSpeakTimestamp = sourceTimestamp;
    room.lastThingSpeakTimestampMs = currentTsMs;
    room.ews = getRoomEwsPercent(room);
    room.ewsLevel = getEwsLevel(room.ews);
    room.isWasteful = room.ews > EWS_FLAG_THRESHOLD;

    saveEwsState();
}

function syncEwsAfterStateMutation(room, sourceTimestamp) {
    const stats = ensureEwsState(room);
    const nowMs = Date.now();

    if (sourceTimestamp) {
        room.lastThingSpeakTimestamp = sourceTimestamp;
    }

    stats.lastTrackedAt = nowMs;

    if (room.lightStatus === 'ON' && stats.currentSessionStartMs === null) {
        stats.currentSessionStartMs = nowMs;
        stats.currentSessionLightOnMs = 0;
        stats.currentSessionWasteMs = 0;
    }

    if (room.lightStatus !== 'ON' && stats.currentSessionStartMs !== null) {
        finalizeEwsSession(room, nowMs);
    }

    room.ews = getRoomEwsPercent(room);
    room.ewsLevel = getEwsLevel(room.ews);
    room.isWasteful = room.ews > EWS_FLAG_THRESHOLD;

    saveEwsState();
}

function saveEwsState() {
    const payload = {};

    roomData.forEach(room => {
        const stats = ensureEwsState(room);
        payload[room.room] = {
            ewsStats: stats,
            ews: room.ews,
            ewsLevel: room.ewsLevel,
            isWasteful: room.isWasteful,
            lastThingSpeakTimestamp: room.lastThingSpeakTimestamp || null,
            ewsAlertRaised: !!room.ewsAlertRaised
        };
    });

    localStorage.setItem(EWS_STORAGE_KEY, JSON.stringify(payload));
}

function loadEwsState() {
    const raw = localStorage.getItem(EWS_STORAGE_KEY);
    if (!raw) return;

    try {
        const parsed = JSON.parse(raw);

        roomData.forEach(room => {
            const existing = parsed[room.room];
            if (!existing) {
                ensureEwsState(room);
                return;
            }

            room.ewsStats = existing.ewsStats || createDefaultEwsStats(Date.now());
            room.ews = typeof existing.ews === 'number' ? existing.ews : getRoomEwsPercent(room);
            room.ewsLevel = existing.ewsLevel || getEwsLevel(room.ews);
            room.isWasteful = !!existing.isWasteful;
            room.lastThingSpeakTimestamp = existing.lastThingSpeakTimestamp || null;
            room.ewsAlertRaised = !!existing.ewsAlertRaised;

            ensureEwsState(room);
        });
    } catch (error) {
        console.warn('Failed to restore EWS state:', error);
    }
}

function trackAllRoomsEws() {
    const nowMs = Date.now();

    roomData.forEach(room => {
        if (room.isRealTime && room.room === 'Room 101') {
            return;
        }

        trackEwsForRoom(room, nowMs);

        if (room.ews > EWS_FLAG_THRESHOLD && !room.ewsAlertRaised) {
            room.ewsAlertRaised = true;
            console.warn(`⚠️ Energy Waste Detected in ${room.room} (EWS ${room.ews}%)`);
        }

        if (room.ews <= EWS_FLAG_THRESHOLD) {
            room.ewsAlertRaised = false;
        }
    });

    saveEwsState();
}

function formatMinutesFromSeconds(totalSeconds) {
    return `${Math.max(0, Math.round(totalSeconds / 60))} min`;
}

function renderRoom101SessionAnalysis() {
    const room = roomData.find(r => r.room === 'Room 101');
    const rowsElement = document.getElementById('ewsSessionRows');
    const overallDurationElement = document.getElementById('ewsOverallDuration');
    const overallLightOnElement = document.getElementById('ewsOverallLightOn');
    const overallNoMotionElement = document.getElementById('ewsOverallNoMotion');
    const overallScoreElement = document.getElementById('ewsOverallScore');
    const overallStatusElement = document.getElementById('ewsOverallStatus');
    const chartCanvas = document.getElementById('ewsTrendChart');

    if (!room || !rowsElement || !chartCanvas) {
        return;
    }

    const analyticsView = document.getElementById('analyticsView');
    if (analyticsView && analyticsView.style.display === 'none') {
        return;
    }

    const stats = ensureEwsState(room);
    const nowMs = Date.now();
    const sessions = [...(stats.sessions || [])];

    if (stats.currentSessionStartMs !== null) {
        const runningDurationSec = Math.max(0, Math.round((nowMs - stats.currentSessionStartMs) / 1000));
        const runningLightOnSec = Math.max(0, Math.round(stats.currentSessionLightOnMs / 1000));
        const runningWasteSec = Math.max(0, Math.round(stats.currentSessionWasteMs / 1000));
        const runningEws = stats.currentSessionLightOnMs > 0
            ? Number(((stats.currentSessionWasteMs / stats.currentSessionLightOnMs) * 100).toFixed(1))
            : 0;

        sessions.push({
            startTime: new Date(stats.currentSessionStartMs).toISOString(),
            endTime: null,
            durationSec: runningDurationSec,
            lightOnSec: runningLightOnSec,
            wasteSec: runningWasteSec,
            ews: runningEws,
            sourceTimestamp: room.lastThingSpeakTimestamp || null,
            isLive: true
        });
    }

    const sessionWindow = sessions.slice(-6);

    if (sessionWindow.length === 0) {
        rowsElement.innerHTML = '<tr><td colspan="6" style="text-align:center; color:#666;">No session data yet</td></tr>';
    } else {
        rowsElement.innerHTML = sessionWindow.map((session, index) => {
            const ewsValue = Number(session.ews || 0).toFixed(1);
            const flagged = Number(session.ews || 0) > EWS_FLAG_THRESHOLD;
            const statusClass = flagged ? 'ews-status-flagged' : 'ews-status-normal';
            const statusText = flagged ? 'Flagged' : 'Normal';

            return `
                <tr>
                    <td>Session ${index + 1}${session.isLive ? ' (Live)' : ''}</td>
                    <td>${formatMinutesFromSeconds(session.durationSec || 0)}</td>
                    <td>${formatMinutesFromSeconds(session.lightOnSec || 0)}</td>
                    <td>${formatMinutesFromSeconds(session.wasteSec || 0)}</td>
                    <td class="${flagged ? 'ews-highlight' : ''}">${ewsValue}%</td>
                    <td class="${statusClass}">${statusText}</td>
                </tr>
            `;
        }).join('');
    }

    const totalDurationSec = sessions.reduce((sum, s) => sum + (s.durationSec || 0), 0);
    const totalLightOnSec = Math.round(stats.totalLightOnMs / 1000);
    const totalNoMotionSec = Math.round(stats.wasteMs / 1000);
    const overallEws = totalLightOnSec > 0 ? Number(((totalNoMotionSec / totalLightOnSec) * 100).toFixed(1)) : 0;
    const overallFlagged = overallEws > EWS_FLAG_THRESHOLD;

    if (overallDurationElement) {
        overallDurationElement.textContent = formatMinutesFromSeconds(totalDurationSec);
    }
    if (overallLightOnElement) {
        overallLightOnElement.textContent = formatMinutesFromSeconds(totalLightOnSec);
    }
    if (overallNoMotionElement) {
        overallNoMotionElement.textContent = formatMinutesFromSeconds(totalNoMotionSec);
    }
    if (overallScoreElement) {
        overallScoreElement.textContent = `${overallEws}%`;
        overallScoreElement.className = overallFlagged ? 'ews-highlight' : '';
    }
    if (overallStatusElement) {
        overallStatusElement.textContent = overallFlagged ? 'Flagged' : 'Normal';
        overallStatusElement.className = overallFlagged ? 'ews-status-flagged' : 'ews-status-normal';
    }

    if (typeof Chart !== 'undefined') {
        // Keep chart based on completed sessions to avoid visual drift from frequent UI refreshes.
        const chartSessions = (stats.sessions || []).slice(-6);
        const labels = chartSessions.map((_, idx) => `Session ${idx + 1}`);
        const ewsSeries = chartSessions.map(session => Number((session.ews || 0).toFixed(1)));
        const thresholdSeries = labels.map(() => EWS_FLAG_THRESHOLD);
        const renderKey = JSON.stringify({ labels, ewsSeries });

        if (ewsTrendChartInstance && renderKey === ewsTrendLastRenderKey) {
            return;
        }

        const chartParent = chartCanvas.parentElement;
        const parentWidth = chartParent ? Math.max(320, Math.floor(chartParent.clientWidth) - 4) : 560;
        chartCanvas.width = parentWidth;
        chartCanvas.height = 220;

        if (!ewsTrendChartInstance) {
            ewsTrendChartInstance = new Chart(chartCanvas, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'EWS (%)',
                            data: ewsSeries,
                            borderColor: '#1f77d0',
                            backgroundColor: 'rgba(31, 119, 208, 0.15)',
                            pointBackgroundColor: '#1f77d0',
                            tension: 0.3,
                            fill: false
                        },
                        {
                            label: `Inefficiency Threshold (${EWS_FLAG_THRESHOLD}%)`,
                            data: thresholdSeries,
                            borderColor: '#d9534f',
                            borderDash: [6, 4],
                            pointRadius: 0,
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: false,
                    maintainAspectRatio: false,
                    animation: false,
                    scales: {
                        y: {
                            min: 0,
                            max: 100,
                            title: {
                                display: true,
                                text: 'EWS (%)'
                            }
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Sessions'
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom'
                        }
                    }
                }
            });
        } else {
            ewsTrendChartInstance.data.labels = labels;
            ewsTrendChartInstance.data.datasets[0].data = ewsSeries;
            ewsTrendChartInstance.data.datasets[1].data = thresholdSeries;
            ewsTrendChartInstance.resize();
            ewsTrendChartInstance.update('none');
        }

        ewsTrendLastRenderKey = renderKey;
    }
}

// Generate distance
function generateDistance(hasMotion) {
    if (hasMotion) {
        return Math.floor(Math.random() * 100) + 50;
    } else {
        return Math.floor(Math.random() * 100) + 200;
    }
}

// Room data
let roomData = [
    { room: 'Room 101', type: 'classroom', isRealTime: true, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 52, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:15' },
    { room: 'Room 102', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 0, ldr: 1, distance: 245, lightStatus: 'OFF', peoplePresent: 'NO', updateTime: '14:23:10' },
    { room: 'Lab A1', type: 'lab', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 78, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:18' },
    { room: 'Room 103', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 0, ldr: 1, distance: 198, lightStatus: 'OFF', peoplePresent: 'NO', updateTime: '14:23:05' },
    { room: 'Lab B2', type: 'lab', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 63, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:20' },
    { room: 'Room 104', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 89, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:12' },
    { room: 'Room 105', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 0, ldr: 1, distance: 267, lightStatus: 'OFF', peoplePresent: 'NO', updateTime: '14:23:08' },
    { room: 'Lab C3', type: 'lab', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 54, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:22' },
    { room: 'Room 106', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 0, ldr: 1, distance: 312, lightStatus: 'OFF', peoplePresent: 'NO', updateTime: '14:23:02' },
    { room: 'Room 107', type: 'classroom', isRealTime: false, lastUpdate: 'Wed, Dec 01, 2024', pir: 1, ldr: 1, distance: 71, lightStatus: 'ON', peoplePresent: 'YES', updateTime: '14:23:25' }
];

let groups = [];
let currentFilter = 'all';
let filteredData = [...roomData];

function initializeEwsTracking() {
    roomData.forEach(room => {
        ensureEwsState(room);
        room.ews = getRoomEwsPercent(room);
        room.ewsLevel = getEwsLevel(room.ews);
        room.isWasteful = room.ews > EWS_FLAG_THRESHOLD;
    });

    loadEwsState();

    roomData.forEach(room => {
        if (room.isRealTime && room.room === 'Room 101') {
            return;
        }

        trackEwsForRoom(room, Date.now());
    });
}

initializeEwsTracking();

function getActiveAdminOverride() {
    const adminOverride = localStorage.getItem('adminOverride');
    if (!adminOverride) {
        return null;
    }

    try {
        const override = JSON.parse(adminOverride);
        return override && override.active ? override : null;
    } catch (error) {
        console.warn('Invalid adminOverride payload:', error);
        return null;
    }
}

function handleAdminOverrideState() {
    const override = getActiveAdminOverride();
    if (override) {
        applyAdminCase(override);
    } else {
        fetchThingSpeakData();
    }
}

// --- 🔄 UPDATE FROM CSV (with Admin Override Support) ---
function updateFromCSV() {
    const { realTimeRoom } = CSV_CONFIG;
    
    const override = getActiveAdminOverride();
    if (override) {
        applyAdminCase(override);
        return; // Skip CSV update
    }
    
    // Normal CSV auto-update mode (only runs if no admin override)
    if (!csvLoaded || csvData.length === 0) {
        console.error('⚠️ CSV not loaded or no data available');
        return;
    }
    
    const dataPoint = csvData[currentDataIndex];
    currentDataIndex = (currentDataIndex + 1) % csvData.length;
    
    const realTimeRoomObject = roomData.find(room => room.room === realTimeRoom);
    
    if (realTimeRoomObject) {
        realTimeRoomObject.pir = dataPoint.pir;
        realTimeRoomObject.ldr = dataPoint.ldr;
        realTimeRoomObject.distance = dataPoint.distance;
        
        const logic = calculateLightStatus(dataPoint.pir, dataPoint.ldr, dataPoint.distance);
        
        realTimeRoomObject.lightStatus = dataPoint.led === 1 ? 'ON' : 'OFF'; // Use LED from CSV
        realTimeRoomObject.peoplePresent = logic.peoplePresent;
        
        const now = new Date();
        realTimeRoomObject.updateTime = now.toLocaleTimeString('en-US', { hour12: false });
        realTimeRoomObject.lastUpdate = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
        
        // Use CSV timestamp for EWS tracking
        const csvTimestamp = new Date(dataPoint.created_at).toISOString();
        trackRoom101EwsFromThingSpeak(realTimeRoomObject, csvTimestamp);
        
        console.log(`✅ Room 101 CSV [${currentDataIndex}/${csvData.length}] - ${dataPoint.created_at} | PIR: ${dataPoint.pir} | LDR: ${dataPoint.ldr} | Distance: ${dataPoint.distance}cm | LED: ${dataPoint.led} | EWS: ${dataPoint.ews}%`);
        
        applyFilter();
        if (document.getElementById('analyticsView')?.style.display !== 'none') {
            updateAnalytics();
        }
    }
}

// --- 🎛️ APPLY ADMIN CASE ---
function applyAdminCase(override) {
    const { realTimeRoom } = CSV_CONFIG;
    const realTimeRoomObject = roomData.find(room => room.room === realTimeRoom);
    
    if (realTimeRoomObject) {
        const caseData = override.data;
        
        realTimeRoomObject.pir = caseData.pir;
        realTimeRoomObject.ldr = caseData.ldr;
        realTimeRoomObject.distance = caseData.distance;
        
        const logic = calculateLightStatus(caseData.pir, caseData.ldr, caseData.distance);
        
        realTimeRoomObject.lightStatus = logic.lightStatus;
        realTimeRoomObject.peoplePresent = logic.peoplePresent;
        
        const now = new Date();
        realTimeRoomObject.updateTime = now.toLocaleTimeString('en-US', { hour12: false });
        realTimeRoomObject.lastUpdate = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
        syncEwsAfterStateMutation(realTimeRoomObject);
        
        console.log(`🎛️ Room 101 MANUAL (Case ${override.case}) - ${realTimeRoomObject.updateTime} | PIR: ${caseData.pir} | LDR: ${caseData.ldr} | Distance: ${caseData.distance}cm | Light: ${logic.lightStatus}`);
        
        applyFilter();
        if (document.getElementById('analyticsView')?.style.display !== 'none') {
            updateAnalytics();
        }
    }
}

// Print report
function printReport() {
    const printWindow = window.open('', '_blank');
    
    const currentDate = new Date().toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });
    
    const currentTime = new Date().toLocaleTimeString('en-US');
    
    let printContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Smart Classroom Report</title>
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    margin: 20px;
                }
                .header {
                    text-align: center;
                    margin-bottom: 30px;
                    border-bottom: 3px solid #0066cc;
                    padding-bottom: 15px;
                }
                .header h1 {
                    color: #0066cc;
                    margin: 0;
                }
                .meta-info {
                    margin: 20px 0;
                    background: #f5f5f5;
                    padding: 15px;
                }
                table { 
                    width: 100%; 
                    border-collapse: collapse; 
                    margin-top: 20px;
                }
                th, td { 
                    border: 1px solid #ddd; 
                    padding: 10px; 
                    text-align: left;
                }
                th { 
                    background: #0066cc; 
                    color: white;
                    font-weight: bold;
                }
                tr:nth-child(even) {
                    background: #f9f9f9;
                }
                .status-on { 
                    color: #ff8800; 
                    font-weight: bold;
                }
                .status-off { 
                    color: #999; 
                    font-weight: bold;
                }
                .footer {
                    margin-top: 30px;
                    text-align: center;
                    font-size: 12px;
                    color: #666;
                }
                @media print {
                    .no-print { display: none; }
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1>🏫 Smart Classroom Monitoring Report</h1>
                <p>Real-time Sensor Data Dashboard</p>
            </div>
            
            <div class="meta-info">
                <p><strong>Report Generated:</strong> ${currentDate} at ${currentTime}</p>
                <p><strong>Filter Applied:</strong> ${document.getElementById('filterSelect').selectedOptions[0].text}</p>
                <p><strong>Total Rooms:</strong> ${filteredData.length}</p>
                <p><strong>Lights ON:</strong> ${filteredData.filter(r => r.lightStatus === 'ON').length}</p>
                <p><strong>Lights OFF:</strong> ${filteredData.filter(r => r.lightStatus === 'OFF').length}</p>
            </div>
            
            <table>
                <thead>
                    <tr>
                        <th>Room Number</th>
                        <th>PIR Motion</th>
                        <th>LDR Light</th>
                        <th>Distance (cm)</th>
                        <th>Light Status</th>
                        <th>People Present</th>
                        <th>Update Time</th>
                    </tr>
                </thead>
                <tbody>
    `;
    
    filteredData.forEach(row => {
        const distanceText = row.pir === 1 ? row.distance + ' cm' : 'N/A';
        const lightClass = row.lightStatus === 'ON' ? 'status-on' : 'status-off';
        
        printContent += `
            <tr>
                <td><strong>${row.room}</strong></td>
                <td>${row.pir === 1 ? '✓ DETECTED' : '✗ CLEAR'}</td>
                <td>${row.ldr === 1 ? 'BRIGHT' : 'DARK'}</td>
                <td>${distanceText}</td>
                <td class="${lightClass}">${row.lightStatus}</td>
                <td>${row.peoplePresent}</td>
                <td>${row.updateTime}</td>
            </tr>
        `;
    });
    
    printContent += `
                </tbody>
            </table>
            
            <div class="footer">
                <p>Smart Classroom IoT Project © 2024</p>
            </div>
            
            <div class="no-print" style="text-align: center; margin-top: 20px;">
                <button onclick="window.print()" style="background: #0066cc; color: white; border: none; padding: 10px 30px; font-size: 16px; cursor: pointer;">
                    🖨️ Print This Report
                </button>
                <button onclick="window.close()" style="background: #999; color: white; border: none; padding: 10px 30px; font-size: 16px; cursor: pointer; margin-left: 10px;">
                    Close
                </button>
            </div>
        </body>
        </html>
    `;
    
    printWindow.document.write(printContent);
    printWindow.document.close();
}

// Download CSV
function downloadCSV() {
    let csv = 'Room Number,Last Update,PIR Motion,LDR Light,Distance (cm),Light Status,People Present,EWS (%),Update Time\n';
    
    filteredData.forEach(row => {
        const distanceText = row.pir === 1 ? row.distance : 'N/A';
        const pirText = row.pir === 1 ? 'DETECTED' : 'CLEAR';
        const ldrText = row.ldr === 1 ? 'BRIGHT' : 'DARK';
        
        const ewsText = typeof row.ews === 'number' ? row.ews : getRoomEwsPercent(row);
        csv += `"${row.room}","${row.lastUpdate}","${pirText}","${ldrText}","${distanceText}","${row.lightStatus}","${row.peoplePresent}","${ewsText}","${row.updateTime}"\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    a.href = url;
    a.download = `smart-classroom-report-${timestamp}.csv`;
    
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
    
    alert('✓ CSV file downloaded successfully!');
}

// Apply filter
function applyFilter() {
    const filterValue = document.getElementById('filterSelect').value;
    currentFilter = filterValue;
    
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    
    filteredData = roomData.filter(row => {
        const matchesSearch = row.room.toLowerCase().includes(searchTerm);
        if (!matchesSearch) return false;
        
        switch(filterValue) {
            case 'all':
                return true;
            case 'classrooms':
                return row.type === 'classroom';
            case 'labs':
                return row.type === 'lab';
            case 'lights-on':
                return row.lightStatus === 'ON';
            case 'lights-off':
                return row.lightStatus === 'OFF';
            default:
                return true;
        }
    });
    
    populateTable(filteredData);
    
    const analyticsView = document.getElementById('analyticsView');
    if (analyticsView && analyticsView.style.display !== 'none') {
        updateAnalytics();
    }
}

function filterRooms() {
    applyFilter();
}

// Populate table
function populateTable(data) {
    const tbody = document.getElementById('dataTableBody');
    tbody.innerHTML = '';
    
    if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align: center; padding: 30px; color: #999;">No rooms found matching your filter</td></tr>';
        return;
    }
    
    data.forEach((row, index) => {
        const tr = document.createElement('tr');
        
        if (row.isRealTime) {
            tr.classList.add('real-time-room');
        }

        if (row.isWasteful) {
            tr.classList.add('waste-flagged');
        }
        
        const logic = calculateLightStatus(row.pir, row.ldr, row.distance);
        const isRoom101Realtime = row.isRealTime && row.room === 'Room 101';

        if (isRoom101Realtime) {
            if (row.ledState) {
                row.lightStatus = row.ledState;
            } else {
                row.lightStatus = logic.lightStatus;
            }

            if (!row.peopleStatusLabel) {
                const presence = evaluateRoom101PresenceState(row.pir, row.distance, row.distance);
                row.peoplePresent = presence.present;
                row.peopleStatusLabel = presence.label;
            }
        } else {
            row.lightStatus = logic.lightStatus;
            row.peoplePresent = logic.peoplePresent;
        }
        
        const pirStatus = row.pir === 1 ? 'DETECTED' : 'CLEAR';
        const pirClass = row.pir === 1 ? 'detected' : 'clear';
        const lightClass = row.lightStatus === 'ON' ? 'on' : 'off';
        const peopleDisplay = isRoom101Realtime ? (row.peopleStatusLabel || row.peoplePresent) : row.peoplePresent;
        const peopleClass = row.peoplePresent === 'YES' ? 'yes' : 'no';
        const ewsValue = typeof row.ews === 'number' ? row.ews : getRoomEwsPercent(row);
        const ewsLevel = getEwsLevel(ewsValue);
        const ldrLevel = row.ldr >= 300 ? 'BRIGHT' : 'DARK';
        const ldrBadgeClass = row.ldr >= 300 ? 'green' : '';
        
        let distanceDisplay;
        if (logic.showDistance && row.pir === 1) {
            distanceDisplay = `<strong>${row.distance} cm</strong>`;
        } else {
            distanceDisplay = `<span style="color: #999;">N/A</span>`;
        }
        
        const isDay = isDayTime();
        let ldrInfo;
        if (isDay) {
            ldrInfo = `LDR: ${ldrLevel} <span style="color: #999; font-size: 11px;">(Day)</span>`;
        } else {
            ldrInfo = `LDR: ${ldrLevel} <span style="color: #999; font-size: 11px;">(Night)</span>`;
        }
        
        const roomNameDisplay = row.isRealTime ? 
                                `<strong>${row.room}</strong> <span class="live-badge">🔴 LIVE</span>` : 
                                `<strong>${row.room}</strong>`;
        
        tr.innerHTML = `
            <td class="checkbox-col">
                <input type="checkbox" class="row-checkbox" data-room="${row.room}">
            </td>
            <td>
                <span class="audio-icon">🔊</span>
                ${roomNameDisplay}
            </td>
            <td>${row.lastUpdate}</td>
            <td>
                <span class="level-badge ${pirClass === 'detected' ? '' : 'green'}">${row.pir}</span>
                <span class="status-badge ${pirClass}">${pirStatus}</span>
            </td>
            <td>
                <span class="level-badge ${ldrBadgeClass}">${row.ldr}</span>
                ${ldrInfo}
            </td>
            <td>${distanceDisplay}</td>
            <td>
                <span class="status-badge ${lightClass}">${row.lightStatus}</span>
            </td>
            <td>
                <span class="status-badge ${peopleClass}">${peopleDisplay}</span>
            </td>
            <td>
                <span class="ews-badge ${ewsLevel}">${ewsValue}%</span>
            </td>
            <td>
                ${row.isRealTime ? `
                    <button onclick="sendRoomCommand('${row.room}', 'ON')">ON</button>
                    <button onclick="sendRoomCommand('${row.room}', 'OFF')">OFF</button>
                ` : `
                    <span style="color: gray;">No Control</span>
                `}
            </td>
        `;
        
        tbody.appendChild(tr);
    });
}

// Sort table
let sortDirection = 1;
function sortTable(columnIndex) {
    filteredData.sort((a, b) => {
        if (a.room < b.room) return -1 * sortDirection;
        if (a.room > b.room) return 1 * sortDirection;
        return 0;
    });
    sortDirection *= -1;
    populateTable(filteredData);
}

function toggleSelectAll() {
    const selectAll = document.getElementById('selectAll');
    const checkboxes = document.querySelectorAll('.row-checkbox');
    checkboxes.forEach(checkbox => {
        checkbox.checked = selectAll.checked;
    });
}

// Modal functions
function openGroupModal() {
    document.getElementById('groupModal').classList.add('active');
    populateRoomList();
    populateGroupsList();
}

function closeGroupModal() {
    document.getElementById('groupModal').classList.remove('active');
}

function populateRoomList() {
    const roomList = document.getElementById('roomList');
    roomList.innerHTML = '';
    
    roomData.forEach(room => {
        const roomItem = document.createElement('div');
        roomItem.className = 'room-item';
        roomItem.innerHTML = `
            <span><strong>${room.room}</strong> (${room.type})</span>
            <button class="delete-btn" onclick="deleteRoom('${room.room}')">Delete</button>
        `;
        roomList.appendChild(roomItem);
    });
}

function addNewRoom() {
    const roomName = document.getElementById('newRoomName').value.trim();
    
    if (!roomName) {
        alert('Please enter a room name');
        return;
    }
    
    if (roomData.find(r => r.room.toLowerCase() === roomName.toLowerCase())) {
        alert('Room already exists!');
        return;
    }
    
    const type = roomName.toLowerCase().includes('lab') ? 'lab' : 'classroom';
    
    const newRoom = {
        room: roomName,
        type: type,
        isRealTime: false,
        lastUpdate: new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' }),
        pir: 0,
        ldr: 1,
        distance: 250,
        lightStatus: 'OFF',
        peoplePresent: 'NO',
        updateTime: new Date().toLocaleTimeString('en-US', { hour12: false })
    };
    
    roomData.push(newRoom);
    ensureEwsState(newRoom);
    syncEwsAfterStateMutation(newRoom);
    document.getElementById('newRoomName').value = '';
    populateRoomList();
    applyFilter();
    
    alert(`✓ ${roomName} added successfully!`);
}

function deleteRoom(roomName) {
    if (!confirm(`Are you sure you want to delete ${roomName}?`)) {
        return;
    }
    
    roomData = roomData.filter(r => r.room !== roomName);
    saveEwsState();
    populateRoomList();
    applyFilter();
    
    alert(`✓ ${roomName} deleted successfully!`);
}

function createGroup() {
    const groupName = document.getElementById('groupName').value.trim();
    
    if (!groupName) {
        alert('Please enter a group name');
        return;
    }
    
    const selectedRooms = [];
    document.querySelectorAll('.row-checkbox:checked').forEach(cb => {
        selectedRooms.push(cb.dataset.room);
    });
    
    if (selectedRooms.length === 0) {
        alert('Please select at least one room');
        return;
    }
    
    groups.push({
        name: groupName,
        rooms: selectedRooms
    });
    
    document.getElementById('groupName').value = '';
    populateGroupsList();
    
    alert(`✓ Group "${groupName}" created with ${selectedRooms.length} rooms!`);
}

function populateGroupsList() {
    const groupsList = document.getElementById('groupsList');
    
    if (groups.length === 0) {
        groupsList.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No groups created yet</p>';
        return;
    }
    
    groupsList.innerHTML = '';
    
    groups.forEach((group, index) => {
        const groupItem = document.createElement('div');
        groupItem.className = 'group-item';
        groupItem.innerHTML = `
            <div class="group-info">
                <div class="group-name">📁 ${group.name}</div>
                <div class="group-rooms">${group.rooms.join(', ')}</div>
            </div>
            <button class="delete-btn" onclick="deleteGroup(${index})">Delete</button>
        `;
        groupsList.appendChild(groupItem);
    });
}

function deleteGroup(index) {
    if (!confirm(`Delete group "${groups[index].name}"?`)) {
        return;
    }
    
    groups.splice(index, 1);
    populateGroupsList();
}

// Simulate updates for other rooms
function simulateRealTimeUpdate() {
    const dummyRooms = roomData.filter(r => !r.isRealTime);
    
    if (dummyRooms.length === 0) return;

    const randomIndex = Math.floor(Math.random() * dummyRooms.length);
    const roomToUpdate = dummyRooms[randomIndex];
    const isDay = isDayTime();

    const originalIndex = roomData.findIndex(r => r.room === roomToUpdate.room);
    
    roomData[originalIndex].pir = Math.random() > 0.6 ? 1 : 0;
    
    if (isDay) {
        roomData[originalIndex].ldr = Math.random() > 0.2 ? 1 : 0;
    } else {
        roomData[originalIndex].ldr = Math.random() > 0.8 ? 1 : 0;
    }
    
    roomData[originalIndex].distance = generateDistance(roomData[originalIndex].pir);
    
    const logic = calculateLightStatus(
        roomData[originalIndex].pir, 
        roomData[originalIndex].ldr, 
        roomData[originalIndex].distance
    );
    
    roomData[originalIndex].lightStatus = logic.lightStatus;
    roomData[originalIndex].peoplePresent = logic.peoplePresent;
    roomData[originalIndex].updateTime = new Date().toLocaleTimeString('en-US', { hour12: false });
    syncEwsAfterStateMutation(roomData[originalIndex]);
    
    applyFilter();
}

// Tab switching
function showTab(tabName) {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    event.target.closest('.nav-tab').classList.add('active');
    
    if (tabName === 'dashboard') {
        document.getElementById('dashboardView').style.display = 'block';
        document.getElementById('analyticsView').style.display = 'none';
        document.getElementById('controlBar').style.display = 'flex';
    } else if (tabName === 'analytics') {
        document.getElementById('dashboardView').style.display = 'none';
        document.getElementById('analyticsView').style.display = 'block';
        document.getElementById('controlBar').style.display = 'none';
        updateAnalytics();
        setTimeout(() => {
            renderRoom101SessionAnalysis();
        }, 0);
    }
}

// Update analytics
function updateAnalytics() {
    const currentData = roomData;
    
    const totalRooms = currentData.length;
    const lightsOn = currentData.filter(r => r.lightStatus === 'ON').length;
    const lightsOff = totalRooms - lightsOn;
    const occupied = currentData.filter(r => r.peoplePresent === 'YES').length;
    
    document.getElementById('totalRooms').textContent = totalRooms;
    document.getElementById('lightsOn').textContent = lightsOn;
    document.getElementById('lightsOff').textContent = lightsOff;
    document.getElementById('occupied').textContent = occupied;
    
    const waste = currentData.filter(r => r.lightStatus === 'ON' && r.peoplePresent === 'NO').length;
    const efficient = currentData.filter(r => {
        if (r.peoplePresent === 'YES' && r.lightStatus === 'ON') return true;
        if (r.peoplePresent === 'NO' && r.lightStatus === 'OFF') return true;
        return false;
    }).length;
    const efficiencyRate = totalRooms > 0 ? Math.round((efficient / totalRooms) * 100) : 0;
    
    document.getElementById('energyWaste').textContent = waste;
    document.getElementById('efficient').textContent = efficient;
    document.getElementById('efficiencyRate').textContent = efficiencyRate + '%';

    const highWasteRooms = currentData.filter(r => (r.ews || 0) > EWS_FLAG_THRESHOLD).length;
    const avgEws = totalRooms > 0
        ? Number((currentData.reduce((sum, room) => sum + (room.ews || 0), 0) / totalRooms).toFixed(1))
        : 0;
    const worstRoomData = currentData.reduce((worst, room) => {
        if (!worst || (room.ews || 0) > (worst.ews || 0)) {
            return room;
        }
        return worst;
    }, null);

    const highWasteElement = document.getElementById('highWasteRooms');
    const avgEwsElement = document.getElementById('avgEws');
    const worstRoomElement = document.getElementById('worstRoom');

    if (highWasteElement) {
        highWasteElement.textContent = highWasteRooms;
    }

    if (avgEwsElement) {
        avgEwsElement.textContent = `${avgEws}%`;
    }

    if (worstRoomElement) {
        worstRoomElement.textContent = worstRoomData ? `${worstRoomData.room} (${worstRoomData.ews || 0}%)` : '-';
    }
    
    const motionDetected = currentData.filter(r => r.pir === 1).length;
    const motionClear = currentData.filter(r => r.pir === 0).length;
    
    document.getElementById('motionDetected').textContent = motionDetected;
    document.getElementById('motionClear').textContent = motionClear;
    
    const brightRooms = currentData.filter(r => r.ldr >= 300).length;
    const darkRooms = currentData.filter(r => r.ldr < 300).length;
    
    document.getElementById('brightRooms').textContent = brightRooms;
    document.getElementById('darkRooms').textContent = darkRooms;
    
    const roomListHtml = currentData.map(roomItem => {
        const isOccupied = roomItem.peoplePresent === 'YES';
        const distanceText = roomItem.pir === 1 ? roomItem.distance + ' cm' : 'N/A';
        const liveIndicator = roomItem.isRealTime ? ' <span class="live-indicator">🔴 LIVE</span>' : '';
        
        return `
            <div class="room-card ${isOccupied ? 'occupied' : 'empty'} ${roomItem.isRealTime ? 'real-time-card' : ''}">
                <div class="room-card-header">
                    <span class="room-name">${roomItem.room}${liveIndicator}</span>
                    <span class="room-status">${isOccupied ? '👥' : '🚫'}</span>
                </div>
                <div class="room-details">
                    <div>💡 Light: <strong>${roomItem.lightStatus}</strong></div>
                    <div>🎯 Motion: <strong>${roomItem.pir === 1 ? 'DETECTED' : 'CLEAR'}</strong></div>
                    <div>📏 Distance: <strong>${distanceText}</strong></div>
                    <div>⚠️ EWS: <strong>${roomItem.ews || 0}%</strong></div>
                    <div>⏰ ${roomItem.updateTime}</div>
                </div>
            </div>
        `;
    }).join('');
    
    document.getElementById('roomOccupancyList').innerHTML = roomListHtml || '<p>No data available</p>';
    
    const activeRooms = currentData
        .filter(r => r.peoplePresent === 'YES')
        .sort((a, b) => {
            const distA = a.distance || 999;
            const distB = b.distance || 999;
            return distA - distB;
        })
        .slice(0, 5);
    
    const topRoomsHtml = activeRooms.map((roomItem, index) => {
        const distanceText = roomItem.pir === 1 ? roomItem.distance + ' cm' : 'N/A';
        const liveIndicator = roomItem.isRealTime ? ' (LIVE)' : '';

        return `
            <div class="top-room-item">
                <div>
                    <span class="top-room-badge">#${index + 1}</span>
                    <span class="top-room-name">${roomItem.room}${liveIndicator}</span>
                </div>
                <div class="top-room-stats">
                    <span>💡 ${roomItem.lightStatus}</span>
                    <span>📏 ${distanceText}</span>
                    <span>⏰ ${roomItem.updateTime}</span>
                </div>
            </div>
        `;
    }).join('');
    
    document.getElementById('topRoomsList').innerHTML = topRoomsHtml || '<p>No active rooms at the moment</p>';
    renderRoom101SessionAnalysis();
    
    console.log('📊 Analytics updated.');
}

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
    roomData.forEach(room => {
        const logic = calculateLightStatus(room.pir, room.ldr, room.distance);
        room.lightStatus = logic.lightStatus;
        room.peoplePresent = logic.peoplePresent;
        if (!logic.showDistance) {
            room.distance = generateDistance(false);
        }

        if (room.isRealTime && room.room === 'Room 101') {
            ensureEwsState(room);
        } else {
            syncEwsAfterStateMutation(room);
        }
    });

    trackAllRoomsEws();
    setInterval(trackAllRoomsEws, 1000);
    
    populateTable(roomData);
    
    console.log(`=== SMART CLASSROOM SYSTEM INITIALIZED ===`);
    console.log(`Current Time: ${new Date().toLocaleTimeString('en-US', { hour12: false })}`);
    console.log(`Mode: ${isDayTime() ? 'DAY MODE' : 'NIGHT MODE'}`);
    console.log(`Total Rooms: ${roomData.length}`);
    console.log(`Real-Time Room: ${CSV_CONFIG.realTimeRoom} (Updating every 5s from CSV)`);
    console.log(`CSV Data Points: ${csvData.length} records loaded`);
    console.log(`==========================================`);
    
    // Room 101 is driven by ThingSpeak now, so avoid CSV overwrite on startup.
    // updateFromCSV();

    await loadCSVData(); // Load CSV data first
    setInterval(fetchThingSpeakData, 15000); // every 15 sec
    fetchThingSpeakData(); // first load
    
    // Start dummy data simulation every 3 seconds (for other rooms)
    setInterval(simulateRealTimeUpdate, 3000);
    
    // Start CSV data updates every 5 seconds (for Room 101)
    setInterval(updateFromCSV, 1000); // Fast CSV processing for EWS
    
    // Listen for localStorage changes (when admin makes changes)
    window.addEventListener('storage', function(e) {
        if (e.key === 'adminOverride') {
            console.log('🔔 Admin override detected - updating immediately!');
            handleAdminOverrideState();
        }
    });
    
    // Also check for changes every second (for same-window updates)
    let lastOverrideCheck = localStorage.getItem('adminOverride');
    setInterval(() => {
        const currentOverride = localStorage.getItem('adminOverride');
        if (currentOverride !== lastOverrideCheck) {
            console.log('🔔 Admin override changed - updating immediately!');
            lastOverrideCheck = currentOverride;
            handleAdminOverrideState();
        }
    }, 1000);
});

// Close modal on outside click
window.onclick = function(event) {
    const modal = document.getElementById('groupModal');
    if (event.target === modal) {
        closeGroupModal();
    }
}