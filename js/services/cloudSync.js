/**
 * Cloud Sync Module - Cloud synchronization for practice records
 * Uses GitHub Contents API to store/retrieve practice data across devices
 */
(function (global) {
    'use strict';

    var STORAGE_KEYS = {
        token: 'cloud_sync_token',
        owner: 'cloud_sync_owner',
        repo: 'cloud_sync_repo',
        path: 'cloud_sync_path',
        autoSync: 'cloud_sync_auto_sync',
        lastSync: 'cloud_sync_last_sync'
    };

    var DEFAULT_SYNC_PATH = 'sync-data.json';
    var SYNC_INTERVAL = 30000; // auto-sync check interval: 30s

    var syncTimer = null;

    function getConfig() {
        try {
            return {
                token: localStorage.getItem(STORAGE_KEYS.token) || '',
                owner: localStorage.getItem(STORAGE_KEYS.owner) || '',
                repo: localStorage.getItem(STORAGE_KEYS.repo) || '',
                path: localStorage.getItem(STORAGE_KEYS.path) || DEFAULT_SYNC_PATH,
                autoSync: localStorage.getItem(STORAGE_KEYS.autoSync) === 'true'
            };
        } catch (_) {
            return { token: '', owner: '', repo: '', path: DEFAULT_SYNC_PATH, autoSync: false };
        }
    }

    function setConfig(key, value) {
        try {
            localStorage.setItem(STORAGE_KEYS[key], value);
        } catch (_) { }
    }

    function isConfigured() {
        var config = getConfig();
        return !!(config.token && config.owner && config.repo);
    }

    function getApiUrl(config, path) {
        return 'https://api.github.com/repos/' + config.owner + '/' + config.repo + '/contents/' + encodeURIComponent(path || config.path);
    }

    function getAuthHeader(config) {
        return 'token ' + config.token;
    }

    /**
     * Collect all local data to sync
     */
    function collectLocalData() {
        var data = {
            version: 2,
            timestamp: Date.now(),
            practiceRecords: [],
            userStats: {},
            examIndex: []
        };

        try {
            // Practice records
            if (typeof global.getPracticeRecordsState === 'function') {
                data.practiceRecords = global.getPracticeRecordsState();
            } else if (Array.isArray(global.practiceRecords)) {
                data.practiceRecords = global.practiceRecords;
            }
        } catch (_) { }

        try {
            // User stats
            if (global.storage && typeof global.storage.get === 'function') {
                var stats = global.storage.get('user_stats', {});
                if (stats && typeof stats.then === 'function') {
                    // async storage - skip for now, will be handled differently
                } else {
                    data.userStats = stats;
                }
            }
        } catch (_) { }

        try {
            // Exam index (for cross-device consistency)
            if (typeof global.getExamIndexState === 'function') {
                var index = global.getExamIndexState();
                if (Array.isArray(index)) {
                    data.examIndex = index.map(function (e) {
                        return {
                            id: e.id,
                            title: e.title,
                            category: e.category,
                            frequency: e.frequency,
                            hasHtml: e.hasHtml,
                            hasPdf: e.hasPdf
                        };
                    });
                }
            }
        } catch (_) { }

        return data;
    }

    /**
     * Apply remote data to local storage
     */
    function applyRemoteData(remoteData) {
        if (!remoteData || typeof remoteData !== 'object') return;

        // Apply practice records
        if (Array.isArray(remoteData.practiceRecords)) {
            try {
                if (typeof global.setPracticeRecordsState === 'function') {
                    global.setPracticeRecordsState(remoteData.practiceRecords);
                }
            } catch (_) { }

            try {
                if (global.storage && typeof global.storage.set === 'function') {
                    global.storage.set('practice_records', remoteData.practiceRecords);
                }
            } catch (_) { }

            // Update UI
            try {
                if (typeof global.updatePracticeView === 'function') {
                    global.updatePracticeView();
                }
            } catch (_) { }
            try {
                if (global.app && typeof global.app.refreshOverviewData === 'function') {
                    global.app.refreshOverviewData();
                }
            } catch (_) { }
        }

        // Apply user stats
        if (remoteData.userStats && typeof remoteData.userStats === 'object') {
            try {
                if (global.storage && typeof global.storage.set === 'function') {
                    global.storage.set('user_stats', remoteData.userStats);
                }
            } catch (_) { }
        }

        setConfig('lastSync', new Date().toISOString());
    }

    /**
     * Upload local data to GitHub
     */
    async function pushData() {
        var config = getConfig();
        if (!isConfigured()) {
            throw new Error('Cloud sync not configured');
        }

        var localData = collectLocalData();
        var content = btoa(unescape(encodeURIComponent(JSON.stringify(localData, null, 2))));
        var url = getApiUrl(config);

        // First, try to get the current file to get its SHA
        var sha = null;
        try {
            var resp = await fetch(url, {
                headers: { 'Authorization': getAuthHeader(config), 'Accept': 'application/vnd.github+json' }
            });
            if (resp.ok) {
                var fileData = await resp.json();
                sha = fileData.sha;
            }
        } catch (_) { }

        // Upload
        var body = {
            message: 'Cloud sync: ' + new Date().toISOString(),
            content: content
        };
        if (sha) body.sha = sha;

        var uploadResp = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': getAuthHeader(config),
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!uploadResp.ok) {
            var err = await uploadResp.json().catch(function () { return {}; });
            throw new Error('Upload failed: ' + (err.message || uploadResp.status));
        }

        setConfig('lastSync', new Date().toISOString());
        return true;
    }

    /**
     * Download remote data from GitHub
     */
    async function pullData() {
        var config = getConfig();
        if (!isConfigured()) {
            throw new Error('Cloud sync not configured');
        }

        var url = getApiUrl(config);
        var resp = await fetch(url, {
            headers: { 'Authorization': getAuthHeader(config), 'Accept': 'application/vnd.github+json' }
        });

        if (resp.status === 404) {
            throw new Error('No sync data found. Push first.');
        }
        if (!resp.ok) {
            throw new Error('Download failed: ' + resp.status);
        }

        var fileData = await resp.json();
        var content = decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, ''))));
        var remoteData = JSON.parse(content);

        applyRemoteData(remoteData);
        return remoteData;
    }

    /**
     * Smart sync: merge local and remote data
     */
    async function smartSync() {
        var config = getConfig();
        if (!isConfigured()) {
            throw new Error('Cloud sync not configured');
        }

        var url = getApiUrl(config);
        var remoteData = null;
        var sha = null;

        // Try to get remote data
        try {
            var resp = await fetch(url, {
                headers: { 'Authorization': getAuthHeader(config), 'Accept': 'application/vnd.github+json' }
            });
            if (resp.ok) {
                var fileData = await resp.json();
                sha = fileData.sha;
                var content = decodeURIComponent(escape(atob(fileData.content.replace(/\n/g, ''))));
                remoteData = JSON.parse(content);
            }
        } catch (_) { }

        var localData = collectLocalData();

        if (!remoteData) {
            // No remote data, just push local
            return await pushData();
        }

        // Merge practice records by ID
        var localRecords = localData.practiceRecords || [];
        var remoteRecords = remoteData.practiceRecords || [];
        var mergedRecords = [];
        var recordMap = {};

        // Add all remote records first
        remoteRecords.forEach(function (r) {
            if (r && r.id) {
                recordMap[r.id] = r;
            }
        });

        // Override/add with local records (local takes priority if newer)
        localRecords.forEach(function (r) {
            if (r && r.id) {
                var existing = recordMap[r.id];
                if (!existing || (r.startTime || 0) > (existing.startTime || 0)) {
                    recordMap[r.id] = r;
                }
            }
        });

        mergedRecords = Object.keys(recordMap).map(function (k) { return recordMap[k]; });

        // Build merged data
        var mergedData = {
            version: 2,
            timestamp: Date.now(),
            practiceRecords: mergedRecords,
            userStats: localData.userStats,
            examIndex: localData.examIndex
        };

        // Apply merged records locally
        applyRemoteData(mergedData);

        // Upload merged data
        var content = btoa(unescape(encodeURIComponent(JSON.stringify(mergedData, null, 2))));
        var body = {
            message: 'Cloud sync (merged): ' + new Date().toISOString(),
            content: content
        };
        if (sha) body.sha = sha;

        var uploadResp = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': getAuthHeader(config),
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        if (!uploadResp.ok) {
            var err = await uploadResp.json().catch(function () { return {}; });
            throw new Error('Sync upload failed: ' + (err.message || uploadResp.status));
        }

        setConfig('lastSync', new Date().toISOString());
        return mergedData;
    }

    /**
     * Start auto-sync timer
     */
    function startAutoSync() {
        stopAutoSync();
        syncTimer = setInterval(function () {
            if (isConfigured() && getConfig().autoSync) {
                smartSync().catch(function (e) {
                    console.warn('[CloudSync] Auto-sync failed:', e.message);
                });
            }
        }, SYNC_INTERVAL);
    }

    function stopAutoSync() {
        if (syncTimer) {
            clearInterval(syncTimer);
            syncTimer = null;
        }
    }

    // UI Functions
    function showSyncStatus(message, type) {
        var el = document.getElementById('cloud-sync-status');
        if (el) {
            el.textContent = message;
            el.style.color = type === 'error' ? '#ef4444' : (type === 'success' ? '#10b981' : '#6b7280');
        }
    }

    function updateSyncUI() {
        var config = getConfig();
        var configured = isConfigured();

        var statusEl = document.getElementById('cloud-sync-status');
        var configSection = document.getElementById('cloud-sync-config');
        var connectedSection = document.getElementById('cloud-sync-connected');
        var lastSyncEl = document.getElementById('cloud-sync-last-time');
        var autoSyncToggle = document.getElementById('cloud-sync-auto-toggle');

        if (configured) {
            if (configSection) configSection.style.display = 'none';
            if (connectedSection) connectedSection.style.display = 'block';
            if (autoSyncToggle) autoSyncToggle.checked = config.autoSync;

            var repoEl = document.getElementById('cloud-sync-repo-name');
            if (repoEl) repoEl.textContent = config.owner + '/' + config.repo;

            if (config.lastSync) {
                if (lastSyncEl) lastSyncEl.textContent = new Date(config.lastSync).toLocaleString();
                showSyncStatus('Ready to sync', 'success');
            } else {
                showSyncStatus('Connected - click sync to start', 'success');
            }

            if (config.autoSync) {
                startAutoSync();
            }
        } else {
            if (configSection) configSection.style.display = 'block';
            if (connectedSection) connectedSection.style.display = 'none';
        }
    }

    async function handleConnect() {
        var tokenInput = document.getElementById('cloud-sync-token-input');
        var repoInput = document.getElementById('cloud-sync-repo-input');

        var token = tokenInput ? tokenInput.value.trim() : '';
        var repoFull = repoInput ? repoInput.value.trim() : '';

        if (!token) {
            showSyncStatus('Please enter GitHub token', 'error');
            return;
        }
        if (!repoFull || repoFull.indexOf('/') === -1) {
            showSyncStatus('Please enter repo as owner/repo', 'error');
            return;
        }

        var parts = repoFull.split('/');
        var owner = parts[0].trim();
        var repo = parts[1].trim();

        // Test connection
        showSyncStatus('Testing connection...', 'info');
        try {
            var resp = await fetch('https://api.github.com/repos/' + owner + '/' + repo, {
                headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
            });
            if (!resp.ok) {
                throw new Error('Cannot access repo (HTTP ' + resp.status + ')');
            }

            setConfig('token', token);
            setConfig('owner', owner);
            setConfig('repo', repo);
            setConfig('path', DEFAULT_SYNC_PATH);

            // Clear input fields for security
            if (tokenInput) tokenInput.value = '';
            if (repoInput) repoInput.value = '';

            showSyncStatus('Connected successfully!', 'success');
            updateSyncUI();
        } catch (e) {
            showSyncStatus('Connection failed: ' + e.message, 'error');
        }
    }

    function handleDisconnect() {
        Object.keys(STORAGE_KEYS).forEach(function (key) {
            try { localStorage.removeItem(STORAGE_KEYS[key]); } catch (_) { }
        });
        stopAutoSync();
        updateSyncUI();
        showSyncStatus('Disconnected', 'info');
    }

    async function handleSync() {
        if (!isConfigured()) {
            showSyncStatus('Not configured', 'error');
            return;
        }
        showSyncStatus('Syncing...', 'info');
        try {
            await smartSync();
            showSyncStatus('Sync complete!', 'success');
            updateSyncUI();
        } catch (e) {
            showSyncStatus('Sync failed: ' + e.message, 'error');
        }
    }

    function handleAutoSyncToggle() {
        var toggle = document.getElementById('cloud-sync-auto-toggle');
        var enabled = toggle ? toggle.checked : false;
        setConfig('autoSync', enabled ? 'true' : 'false');
        if (enabled) {
            startAutoSync();
            showSyncStatus('Auto-sync enabled', 'success');
        } else {
            stopAutoSync();
            showSyncStatus('Auto-sync disabled', 'info');
        }
    }

    // Initialize when DOM is ready
    function init() {
        // Bind button events
        var connectBtn = document.getElementById('cloud-sync-connect-btn');
        if (connectBtn) connectBtn.addEventListener('click', handleConnect);

        var disconnectBtn = document.getElementById('cloud-sync-disconnect-btn');
        if (disconnectBtn) disconnectBtn.addEventListener('click', handleDisconnect);

        var syncBtn = document.getElementById('cloud-sync-sync-btn');
        if (syncBtn) syncBtn.addEventListener('click', handleSync);

        var pushBtn = document.getElementById('cloud-sync-push-btn');
        if (pushBtn) pushBtn.addEventListener('click', async function () {
            showSyncStatus('Uploading...', 'info');
            try { await pushData(); showSyncStatus('Upload complete!', 'success'); updateSyncUI(); }
            catch (e) { showSyncStatus('Upload failed: ' + e.message, 'error'); }
        });

        var pullBtn = document.getElementById('cloud-sync-pull-btn');
        if (pullBtn) pullBtn.addEventListener('click', async function () {
            showSyncStatus('Downloading...', 'info');
            try { await pullData(); showSyncStatus('Download complete!', 'success'); updateSyncUI(); }
            catch (e) { showSyncStatus('Download failed: ' + e.message, 'error'); }
        });

        var autoToggle = document.getElementById('cloud-sync-auto-toggle');
        if (autoToggle) autoToggle.addEventListener('change', handleAutoSyncToggle);

        updateSyncUI();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    global.CloudSync = {
        getConfig: getConfig,
        isConfigured: isConfigured,
        pushData: pushData,
        pullData: pullData,
        smartSync: smartSync,
        startAutoSync: startAutoSync,
        stopAutoSync: stopAutoSync
    };
})(typeof window !== 'undefined' ? window : this);
