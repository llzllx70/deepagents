/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class AuthModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    isAuthenticated() {
        const app = this.app;
        return Boolean(app.authToken);
    }

    authHeaders(extra = {}) {
        const app = this.app;
        const headers = { ...extra };
        if (app.authToken) {
            headers['X-Auth-Token'] = app.authToken;
        }
        return headers;
    }

    async authFetch(url, options = {}) {
        const headers = this.authHeaders(options.headers || {});
        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) {
            this.handleAuthExpired();
        }
        return response;
    }

    handleAuthExpired() {
        if (!this.isAuthenticated()) return;
        this.handleLogout({ silent: true, statusMessage: '登录已失效，请重新登录' });
    }

    setLoginStatus(message, level = 'info') {
        const app = this.app;
        if (!app.elements.loginStatus) return;
        app.elements.loginStatus.textContent = message || '';
        app.elements.loginStatus.classList.remove('error', 'success');
        if (level === 'error') {
            app.elements.loginStatus.classList.add('error');
        } else if (level === 'success') {
            app.elements.loginStatus.classList.add('success');
        }
    }

    applyLoggedOutState() {
        const app = this.app;
        app.authToken = null;
        app.currentUser = null;
        app.chatHistory = [];
        app.history.renderHistory();
        app.network.disconnectWebSocket({ allowReconnect: false });
        app.sessionId = null;
        app.wsUrl = null;
        app.currentRunId = null;
        app.activeChatId = null;
        app.isRunning = false;
        app.currentRunStatus = null;
        app.pendingMessages = [];
        app.pendingRunStatusId = null;
        app.runIdToChatId.clear();
        app.runStates.clear();
        app.messageBuffer.clear();
        app.ui.updateConnectionStatus('disconnected');
        app.elements.chatTitle.textContent = '未登录';
        app.elements.welcomeMessage.style.display = 'flex';
        app.ui.resetChatView();
        app.autoApprove = true;
        if (app.elements.userInput) {
            app.elements.userInput.value = '';
            app.elements.userInput.disabled = true;
            app.elements.userInput.placeholder = '请先登录';
        }
        if (app.elements.sendBtn) app.elements.sendBtn.disabled = true;
        if (app.elements.newChatBtn) app.elements.newChatBtn.disabled = true;
        if (app.elements.autoApproveToggle) {
            app.elements.autoApproveToggle.disabled = true;
            app.elements.autoApproveToggle.checked = app.autoApprove;
        }
        if (app.elements.loginForm) app.elements.loginForm.classList.remove('hidden');
        if (app.elements.logoutBtn) app.elements.logoutBtn.disabled = true;
        if (app.elements.loginUser) app.elements.loginUser.textContent = '未登录';
        if (app.elements.loginPassword) app.elements.loginPassword.value = '';
        this.setLoginStatus('');
        app.utils.updateBridgeMeta();
        app.ui.updateSendButton();
    }

    applyLoggedInState() {
        const app = this.app;
        if (app.elements.userInput) {
            app.elements.userInput.disabled = false;
            app.elements.userInput.placeholder = app.defaultInputPlaceholder || '';
        }
        if (app.elements.newChatBtn) app.elements.newChatBtn.disabled = false;
        if (app.elements.autoApproveToggle) {
            app.elements.autoApproveToggle.disabled = false;
            app.elements.autoApproveToggle.checked = app.autoApprove;
        }
        if (app.elements.loginForm) app.elements.loginForm.classList.add('hidden');
        if (app.elements.logoutBtn) app.elements.logoutBtn.disabled = false;
        if (app.elements.loginUser) {
            app.elements.loginUser.textContent = app.currentUser ? `已登录：${app.currentUser}` : '已登录';
        }
        app.ui.updateSendButton();
    }

    async handleLogin() {
        const app = this.app;
        if (!app.serverUrl) return;
        const username = app.elements.loginUsername?.value?.trim() || '';
        const password = app.elements.loginPassword?.value || '';
        if (!username || !password) {
            this.setLoginStatus('请输入账号和密码', 'error');
            return;
        }
        this.setLoginStatus('登录中…');
        if (app.elements.loginBtn) app.elements.loginBtn.disabled = true;
        try {
            const response = await fetch(`${app.serverUrl}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!response.ok) {
                throw new Error(`登录失败：${response.statusText || response.status}`);
            }
            const data = await response.json();
            if (!data?.token) {
                throw new Error('登录失败：无效响应');
            }
            app.authToken = data.token;
            app.currentUser = data.username || username;
            if (app.elements.loginPassword) app.elements.loginPassword.value = '';
            this.applyLoggedInState();
            this.setLoginStatus('登录成功', 'success');
            app.utils.updateBridgeMeta();
            await this.afterLogin();
        } catch (error) {
            this.setLoginStatus(error.message || '登录失败', 'error');
        } finally {
            if (app.elements.loginBtn) app.elements.loginBtn.disabled = false;
        }
    }

    async handleLogout({ silent = false, statusMessage = '' } = {}) {
        const app = this.app;
        if (app.serverUrl && app.authToken) {
            try {
                await fetch(`${app.serverUrl}/logout`, {
                    method: 'POST',
                    headers: this.authHeaders()
                });
            } catch {
                // ignore logout failures
            }
        }
        this.applyLoggedOutState();
        if (statusMessage) {
            this.setLoginStatus(statusMessage, 'error');
        } else if (!silent) {
            this.setLoginStatus('已退出登录');
        }
    }

    async afterLogin() {
        const app = this.app;
        await this.loadUserConfig();
        await app.history.loadHistory();
        app.history.renderHistory();
        const resumed = await app.network.resumeSessionIfPossible();
        if (!resumed) {
            app.ui.updateConnectionStatus('disconnected');
            app.elements.chatTitle.textContent = '新对话';
        }
        app.ui.updateInputState();
    }

    async loadUserConfig() {
        const app = this.app;
        if (!app.serverUrl || !this.isAuthenticated()) return;
        try {
            const response = await this.authFetch(`${app.serverUrl}/user_config`);
            if (!response.ok) return;
            const config = await response.json();
            if (Object.prototype.hasOwnProperty.call(config, 'auto_approve')) {
                app.autoApprove = Boolean(config.auto_approve);
            }
            app.elements.autoApproveToggle.checked = app.autoApprove;
        } catch {
            // ignore config load failures
        }
    }

    async saveUserConfig() {
        const app = this.app;
        if (!app.serverUrl || !this.isAuthenticated()) return;
        try {
            await this.authFetch(`${app.serverUrl}/user_config`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auto_approve: app.autoApprove })
            });
        } catch {
            // ignore config save failures
        }
    }
}
