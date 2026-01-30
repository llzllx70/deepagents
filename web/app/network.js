/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class NetworkModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    getServerUrl() {
        const hostname = window.location.hostname;
        const defaultUrl = `http://${hostname}:8000`;
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('server') || defaultUrl;
    }

    async createSession() {
        const app = this.app;
        if (!app.auth.isAuthenticated()) {
            app.auth.setLoginStatus('请先登录', 'error');
            throw new Error('未登录');
        }
        try {
            app.ui.updateConnectionStatus('connecting');
            this.logClient('session_create_start', { mode: 'new' });

            const response = await app.auth.authFetch(`${app.serverUrl}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assistant_id: app.assistantId,
                    auto_approve: app.autoApprove
                })
            });

            if (!response.ok) {
                throw new Error(`创建会话失败：${response.statusText}`);
            }

            const data = await response.json();
            this.setSessionId(data.session_id);
            this.logClient('session_created', { sessionId: data.session_id, sandboxId: data.sandbox_id || null, mode: 'new' });
            this.connectWebSocket();
            return data.session_id;
        } catch (error) {
            console.error('创建会话失败：', error);
            app.ui.addLogMessage('error', `连接服务器失败：${error.message}`);
            this.logClient('session_create_failed', { error: String(error.message || error) }, 'error');
            app.ui.updateConnectionStatus('disconnected');
            if (app.forceReconnect) {
                this.attemptReconnect();
            }
            throw error;
        }
    }

    async ensureSession() {
        const app = this.app;
        if (!app.auth.isAuthenticated()) {
            app.auth.setLoginStatus('请先登录', 'error');
            throw new Error('未登录');
        }
        if (app.sessionId) return app.sessionId;
        if (app.sessionCreatePromise) return app.sessionCreatePromise;
        app.sessionCreatePromise = this.createSession();
        try {
            return await app.sessionCreatePromise;
        } finally {
            app.sessionCreatePromise = null;
        }
    }

    handleMissingSession() {
        const app = this.app;
        app.ui.addLogMessage('warning', '当前会话已失效，请重新发送消息以创建新会话。');
        app.sessionId = null;
        app.wsUrl = null;
        app.pendingRunStatusId = null;
        app.pendingMessages = [];
        app.forceReconnect = false;
        app.isRunning = false;
        app.currentRunId = null;
        app.currentRunStatus = null;
        app.ui.updateCancelButton(false);
        app.ui.updateSendButton();
        if (app.activeChatId) {
            app.history.upsertChatRecord({ id: app.activeChatId, sessionId: null, status: 'failed' });
        }
    }

    async deleteSession(sessionId) {
        const app = this.app;
        if (!sessionId) return;
        if (!app.auth.isAuthenticated()) return;
        try {
            const response = await app.auth.authFetch(`${app.serverUrl}/sessions/${sessionId}`, {
                method: 'DELETE'
            });
            if (!response.ok && response.status !== 404) {
                throw new Error(`删除会话失败：${response.statusText}`);
            }
        } catch (error) {
            console.error('删除会话失败：', error);
            app.ui.addLogMessage('warning', `删除会话失败：${error.message}`);
        }
    }

    setSessionId(sessionId) {
        const app = this.app;
        app.sessionId = sessionId;
        const wsProtocol = app.serverUrl.startsWith('https') ? 'wss:' : 'ws:';
        const wsHost = app.serverUrl.replace(/^https?:\/\//, '');
        const tokenParam = app.authToken ? `?token=${encodeURIComponent(app.authToken)}` : '';
        app.wsUrl = `${wsProtocol}//${wsHost}/ws/${app.sessionId}${tokenParam}`;
        app.elements.chatTitle.textContent = sessionId;
        app.utils.updateBridgeMeta();
    }

    connectToSession(sessionId, { requestRunStatusId = null } = {}) {
        const app = this.app;
        if (!sessionId) return;
        app.ui.updateConnectionStatus('connecting');
        app.forceReconnect = true;
        this.setSessionId(sessionId);
        app.pendingRunStatusId = requestRunStatusId;
        this.connectWebSocket();
    }

    switchSession(sessionId, { requestRunStatusId = null } = {}) {
        const app = this.app;
        if (!sessionId) return;
        if (app.sessionId === sessionId && app.ws && app.ws.readyState === WebSocket.OPEN) {
            if (requestRunStatusId) {
                this.send({ type: 'run.status', run_id: requestRunStatusId });
            }
            return;
        }
        this.disconnectWebSocket({ allowReconnect: false });
        this.connectToSession(sessionId, { requestRunStatusId });
    }

    disconnectWebSocket({ allowReconnect = false } = {}) {
        const app = this.app;
        app.shouldReconnect = allowReconnect;
        const ws = app.ws;
        if (!ws) return;
        app.ws = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close();
        }
    }

    hasReconnectWork() {
        const app = this.app;
        if (app.forceReconnect) return true;
        if (app.pendingMessages.length > 0) return true;
        if (app.pendingRunStatusId) return true;
        return app.isRunning || app.utils.isActiveRunStatus(app.currentRunStatus);
    }

    ensureConnection() {
        const app = this.app;
        if (app.ws && (app.ws.readyState === WebSocket.OPEN || app.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        app.forceReconnect = true;
        if (app.wsUrl) {
            app.ui.updateConnectionStatus('connecting');
            this.connectWebSocket();
            return;
        }
        if (app.pendingMessages.length > 0) {
            app.ui.updateConnectionStatus('connecting');
            void this.ensureSession();
        }
    }

    flushPendingMessages() {
        const app = this.app;
        if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
        if (!app.pendingMessages.length) return;
        const queued = app.pendingMessages.slice();
        app.pendingMessages.length = 0;
        queued.forEach(payload => {
            app.ws.send(JSON.stringify(payload));
        });
    }

    connectWebSocket() {
        const app = this.app;
        if (!app.wsUrl || !app.auth.isAuthenticated()) return;
        if (app.ws && (app.ws.readyState === WebSocket.OPEN || app.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        app.shouldReconnect = true;
        const ws = new WebSocket(app.wsUrl);
        app.ws = ws;

        ws.onopen = () => {
            if (app.ws !== ws) return;
            console.log('WebSocket 已连接');
            app.ui.updateConnectionStatus('connected');
            const wasForceReconnect = app.forceReconnect;
            this.logClient('ws_connected', {
                sessionId: app.sessionId,
                url: app.wsUrl,
                readyState: ws.readyState,
                reconnectAttempts: app.reconnectAttempts,
                forceReconnect: wasForceReconnect,
                pendingMessages: app.pendingMessages.length,
                pendingRunStatusId: app.pendingRunStatusId,
                online: navigator.onLine
            });
            app.forceReconnect = false;
            app.reconnectAttempts = 0;
            app.ui.hideReconnectNotice();
            this.send({ type: 'auto_approve', enabled: app.autoApprove });
            const runId = app.pendingRunStatusId || (app.isRunning ? app.currentRunId : null);
            app.pendingRunStatusId = null;
            if (runId) {
                this.send({ type: 'run.status', run_id: runId });
            }
            this.flushPendingMessages();
        };

        ws.onmessage = (event) => {
            if (app.ws !== ws) return;
            try {
                const data = JSON.parse(event.data);
                app.messages.handleMessage(data);
            } catch (error) {
                console.error('解析消息失败：', error);
            }
        };

        ws.onclose = (event) => {
            if (app.ws !== ws) return;
            console.log('WebSocket 已断开');
            app.ui.updateConnectionStatus('disconnected');
            this.logClient('ws_disconnected', {
                sessionId: app.sessionId,
                url: app.wsUrl,
                code: event.code,
                reason: event.reason || '',
                wasClean: event.wasClean,
                readyState: ws.readyState,
                reconnectAttempts: app.reconnectAttempts,
                forceReconnect: app.forceReconnect,
                hasReconnectWork: this.hasReconnectWork(),
                online: navigator.onLine
            });
            if (event.code === 1008) {
                this.logClient('session_missing', { sessionId: app.sessionId, chatId: app.activeChatId });
                this.handleMissingSession();
                return;
            }
            if (app.shouldReconnect && this.hasReconnectWork()) {
                this.attemptReconnect();
            } else {
                app.reconnectAttempts = 0;
            }
        };

        ws.onerror = (error) => {
            if (app.ws !== ws) return;
            console.error('WebSocket 错误：', error);
            app.ui.updateConnectionStatus('disconnected');
            this.logClient('ws_error', {
                sessionId: app.sessionId,
                url: app.wsUrl,
                eventType: error?.type || 'error',
                errorMessage: error?.message || '',
                errorString: String(error),
                readyState: ws.readyState,
                targetReadyState: error?.target?.readyState,
                forceReconnect: app.forceReconnect,
                hasReconnectWork: this.hasReconnectWork(),
                online: navigator.onLine
            }, 'error');
        };
    }

    attemptReconnect() {
        const app = this.app;
        if (!this.hasReconnectWork()) {
            app.reconnectAttempts = 0;
            return;
        }
        const allowInfinite = app.forceReconnect;
        const reachedLimit = app.reconnectAttempts >= app.maxReconnectAttempts;
        if (reachedLimit && !allowInfinite) {
            app.ui.addLogMessage('error', '重连失败，请刷新页面。');
            return;
        }
        if (!reachedLimit) {
            app.reconnectAttempts++;
        }
        const attemptCount = Math.min(app.reconnectAttempts, app.maxReconnectAttempts);
        console.log(`正在尝试重连…（${attemptCount}/${app.maxReconnectAttempts}）`);
        app.ui.showReconnectNotice(attemptCount, app.maxReconnectAttempts);

        setTimeout(() => {
            if (!this.hasReconnectWork()) {
                app.reconnectAttempts = 0;
                return;
            }
            this.ensureConnection();
        }, app.reconnectDelay);
    }

    send(data) {
        const app = this.app;
        if (app.ws && app.ws.readyState === WebSocket.OPEN) {
            app.ws.send(JSON.stringify(data));
            return true;
        }
        app.pendingMessages.push(data);
        this.ensureConnection();
        if (app.pendingMessages.length > 50) {
            app.pendingMessages = app.pendingMessages.slice(-50);
        }
        if (!app.ws || app.ws.readyState !== WebSocket.CONNECTING) {
            console.warn('WebSocket 未连接，消息未发送：', data);
        }
        return false;
    }

    setSessionState({ sessionId, chatId = null, hasMessages = false }) {
        const app = this.app;
        if (!sessionId || !app.auth.isAuthenticated()) return;
        this.persistSessionState({
            session_id: sessionId,
            chat_id: chatId,
            has_messages: Boolean(hasMessages),
            timestamp: Date.now() / 1000
        });
    }

    async loadSessionState() {
        const app = this.app;
        if (!app.serverUrl || !app.auth.isAuthenticated()) return null;
        try {
            const response = await app.auth.authFetch(`${app.serverUrl}/session_state`);
            if (!response.ok) return null;
            const parsed = await response.json();
            if (!parsed || typeof parsed !== 'object') return null;
            return parsed;
        } catch {
            return null;
        }
    }

    async resumeSessionIfPossible() {
        const app = this.app;
        const state = await this.loadSessionState();
        const sessionId = state?.session_id || state?.sessionId || null;
        const chatId = state?.chat_id || state?.chatId || null;
        if (!sessionId) return false;
        if (chatId) {
            app.history.loadChat(chatId, { skipSessionSwitch: true });
        }
        this.setSessionId(sessionId);
        this.logClient('session_resume_attempt', { sessionId: sessionId, mode: 'reuse' });
        this.connectWebSocket();
        return true;
    }

    async persistSessionState(payload) {
        const app = this.app;
        if (!app.serverUrl || !app.auth.isAuthenticated()) return;
        const data = { ...payload };
        try {
            await app.auth.authFetch(`${app.serverUrl}/session_state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
        } catch (error) {
            console.warn('保存会话状态失败：', error);
        }
    }

    logClient(event, detail = {}, level = 'info', { useBeacon = false } = {}) {
        const app = this.app;
        if (!app.serverUrl) return;
        const payload = {
            event,
            detail,
            level,
            session_id: app.sessionId || null,
            ts: Date.now() / 1000
        };
        const url = `${app.serverUrl}/client_logs`;
        const body = JSON.stringify(payload);
        if (useBeacon && navigator.sendBeacon) {
            try {
                navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
                return;
            } catch (error) {
                console.warn('client log beacon failed:', error);
            }
        }
        const headers = app.auth.authHeaders({ 'Content-Type': 'application/json' });
        fetch(url, {
            method: 'POST',
            headers,
            body,
            keepalive: true
        }).catch(error => {
            console.warn('client log failed:', error);
        });
    }
}
