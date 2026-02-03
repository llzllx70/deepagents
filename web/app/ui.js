/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class UiModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
        this.pendingDeleteChatId = null;
        this.attachmentItems = new Map();
    }

    async init() {
        const app = this.app;
        this.cacheElements();
        this.setupEventListeners();

        const navEntry = performance.getEntriesByType('navigation')[0];
        const navType = navEntry?.type || 'navigate';
        const action = navType === 'reload' ? 'refresh' : 'load';
        app.network.logClient('page_load', { url: window.location.href, navType, action });
        app.auth.applyLoggedOutState();
    }

    cacheElements() {
        const app = this.app;
        app.elements = {
            sidebar: document.getElementById('sidebar'),
            newChatBtn: document.getElementById('newChatBtn'),
            sessionList: document.getElementById('sessionList'),
            historyList: document.getElementById('historyList'),
            autoApproveToggle: document.getElementById('autoApproveToggle'),
            connectionStatus: document.getElementById('connectionStatus'),
            loginForm: document.getElementById('loginForm'),
            loginUsername: document.getElementById('loginUsername'),
            loginPassword: document.getElementById('loginPassword'),
            loginBtn: document.getElementById('loginBtn'),
            logoutBtn: document.getElementById('logoutBtn'),
            loginStatus: document.getElementById('loginStatus'),
            loginUser: document.getElementById('loginUser'),

            sidebarToggle: document.getElementById('sidebarToggle'),
            chatTitle: document.getElementById('chatTitle'),
            cancelBtn: document.getElementById('cancelBtn'),

            chatContainer: document.getElementById('chatContainer'),
            welcomeMessage: document.getElementById('welcomeMessage'),
            messages: document.getElementById('messages'),

            userInput: document.getElementById('userInput'),
            sendBtn: document.getElementById('sendBtn'),
            attachBtn: document.getElementById('attachBtn'),
            attachInput: document.getElementById('attachInput'),
            attachmentPreview: document.getElementById('attachmentPreview'),
            inputWrapper: document.querySelector('.input-wrapper'),

            interruptModal: document.getElementById('interruptModal'),
            interruptModalBody: document.getElementById('interruptModalBody'),
            interruptModalFooter: document.getElementById('interruptModalFooter'),
            closeModalBtn: document.getElementById('closeModalBtn'),

            // Delete confirmation modal
            deleteConfirmModal: document.getElementById('deleteConfirmModal'),
            closeDeleteModalBtn: document.getElementById('closeDeleteModalBtn'),
            cancelDeleteBtn: document.getElementById('cancelDeleteBtn'),
            confirmDeleteBtn: document.getElementById('confirmDeleteBtn'),
            
            // Theme toggle
            themeToggle: document.getElementById('themeToggle'),
        };
        app.defaultInputPlaceholder = app.elements.userInput?.getAttribute('placeholder') || '';
    }

    setupEventListeners() {
        const app = this.app;
        app.elements.sidebarToggle.addEventListener('click', () => {
            app.elements.sidebar.classList.toggle('open');
        });

        if (app.elements.newChatBtn) {
            app.elements.newChatBtn.addEventListener('click', () => app.messages.newChat());
        }

        app.elements.autoApproveToggle.addEventListener('change', (e) => {
            app.autoApprove = e.target.checked;
            if (app.sessionId) {
                app.network.send({ type: 'auto_approve', enabled: app.autoApprove });
            }
            app.auth.saveUserConfig();
        });

        if (app.elements.loginForm) {
            app.elements.loginForm.addEventListener('submit', (e) => {
                e.preventDefault();
                app.auth.handleLogin();
            });
        }

        if (app.elements.logoutBtn) {
            app.elements.logoutBtn.addEventListener('click', () => app.auth.handleLogout());
        }
        
        // Theme toggle event
        if (app.elements.themeToggle) {
            app.elements.themeToggle.addEventListener('click', () => this.toggleTheme());
        }

        if (app.elements.cancelBtn) {
            app.elements.cancelBtn.addEventListener('click', () => app.messages.cancelRun());
        }

        app.elements.userInput.addEventListener('input', () => {
            this.adjustTextareaHeight();
            this.updateSendButton();
        });

        app.elements.userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (app.isRunning) {
                    app.messages.cancelRun();
                } else {
                    app.messages.sendMessage();
                }
            }
        });

        app.elements.sendBtn.addEventListener('click', () => {
            if (app.isRunning) {
                app.messages.cancelRun();
            } else {
                app.messages.sendMessage();
            }
        });

        if (app.elements.attachBtn && app.elements.attachInput) {
            app.elements.attachBtn.addEventListener('click', () => {
                if (!app.auth.isAuthenticated()) {
                    app.auth.setLoginStatus('请先登录', 'error');
                    return;
                }
                app.elements.attachInput.click();
            });
            app.elements.attachInput.addEventListener('change', async (event) => {
                const files = Array.from(event.target.files || []);
                if (!files.length) return;
                await this.handleAttachmentUpload(files);
                event.target.value = '';
            });
        }

        if (app.elements.attachmentPreview) {
            app.elements.attachmentPreview.addEventListener('click', (event) => {
                const button = event.target.closest('.attachment-remove');
                if (!button) return;
                const fileId = button.getAttribute('data-file-id');
                if (!fileId) return;
                this.handleAttachmentRemove(fileId);
            });
        }

        document.querySelectorAll('.example-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const prompt = btn.getAttribute('data-prompt');
                app.elements.userInput.value = prompt;
                this.adjustTextareaHeight();
                this.updateSendButton();
                app.elements.userInput.focus();
            });
        });

        app.elements.closeModalBtn.addEventListener('click', () => {
            app.elements.interruptModal.classList.remove('active');
        });

        app.elements.interruptModal.addEventListener('click', (e) => {
            if (e.target === app.elements.interruptModal) {
                app.elements.interruptModal.classList.remove('active');
            }
        });

        // Delete confirmation modal events
        if (app.elements.deleteConfirmModal) {
            app.elements.closeDeleteModalBtn?.addEventListener('click', () => {
                this.hideDeleteConfirmModal();
            });

            app.elements.cancelDeleteBtn?.addEventListener('click', () => {
                this.hideDeleteConfirmModal();
            });

            app.elements.confirmDeleteBtn?.addEventListener('click', () => {
                if (this.pendingDeleteChatId) {
                    app.history.deleteChat(this.pendingDeleteChatId);
                    this.hideDeleteConfirmModal();
                }
            });

            app.elements.deleteConfirmModal.addEventListener('click', (e) => {
                if (e.target === app.elements.deleteConfirmModal) {
                    this.hideDeleteConfirmModal();
                }
            });
        }

        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768) {
                if (!app.elements.sidebar.contains(e.target) &&
                    !app.elements.sidebarToggle.contains(e.target)) {
                    app.elements.sidebar.classList.remove('open');
                }
            }
        });

        window.addEventListener('resize', () => {
            if (window.innerWidth > 768) {
                app.elements.sidebar.classList.remove('open');
            }
            this.updateAttachmentLayout();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (app.elements.deleteConfirmModal?.classList.contains('active')) {
                this.hideDeleteConfirmModal();
                return;
            }
            if (app.elements.interruptModal.classList.contains('active')) {
                app.elements.interruptModal.classList.remove('active');
                return;
            }
            if (app.isRunning) {
                app.messages.cancelRun();
            }
        });

        window.addEventListener('pagehide', () => {
            app.network.logClient('page_hide', { reason: 'pagehide' }, 'info', { useBeacon: true });
            app.history.backgroundCurrentChat('pagehide');
            app.network.disconnectWebSocket({ allowReconnect: false });
        });

        // Global link click handler - open all external links in new tab
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link) return;
            
            const href = link.getAttribute('href');
            if (!href) return;
            
            // Skip if already set to open in new tab
            if (link.target === '_blank') return;
            
            // Skip javascript: links and anchor links
            if (href.startsWith('javascript:') || href === '#') return;
            
            // Skip internal navigation links (e.g., sidebar history items)
            if (link.closest('.history-list') || link.closest('.sidebar')) return;
            
            // Prevent default and open in new tab
            e.preventDefault();
            window.open(href, '_blank', 'noopener,noreferrer');
        });
    }

    showDeleteConfirmModal(chatId) {
        this.pendingDeleteChatId = chatId;
        this.app.elements.deleteConfirmModal?.classList.add('active');
    }

    hideDeleteConfirmModal() {
        this.pendingDeleteChatId = null;
        this.app.elements.deleteConfirmModal?.classList.remove('active');
    }

    createMessageElement(type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;

        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        
        // Use image avatars
        const avatarImg = document.createElement('img');
        if (type === 'user') {
            // User avatar - same image for both themes
            avatarImg.src = 'assets/user-avatar-light.png';
            avatarImg.alt = 'User';
            avatarImg.className = 'user-avatar-img';
        } else {
            // AI uses the logo
            avatarImg.src = 'assets/logo-sidebar.png';
            avatarImg.alt = 'AI';
        }
        avatar.appendChild(avatarImg);

        const content = document.createElement('div');
        content.className = 'message-content';

        // AI 回复添加标题
        if (type === 'assistant') {
            const title = document.createElement('div');
            title.className = 'message-title';
            title.textContent = 'CortexAI';
            content.appendChild(title);
        }

        const text = document.createElement('div');
        text.className = 'message-text';

        content.appendChild(text);
        messageDiv.appendChild(avatar);
        messageDiv.appendChild(content);

        return messageDiv;
    }

    createThinkingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'thinking-indicator';
        indicator.innerHTML = `
            <div class="thinking-dots">
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
                <div class="thinking-dot"></div>
            </div>
            <span class="thinking-text">思考中</span>
        `;
        return indicator;
    }

    showThinkingIndicator(messageElement) {
        if (!messageElement) return null;
        const contentElement = messageElement.querySelector('.message-text');
        if (!contentElement) return null;
        
        // Check if thinking indicator already exists
        let indicator = contentElement.querySelector('.thinking-indicator');
        if (!indicator) {
            indicator = this.createThinkingIndicator();
            contentElement.appendChild(indicator);
        }
        return indicator;
    }

    hideThinkingIndicator(messageElement) {
        if (!messageElement) return;
        const indicator = messageElement.querySelector('.thinking-indicator');
        if (indicator) {
            indicator.remove();
        }
    }

    getRunState(runId) {
        const app = this.app;
        if (!runId) return null;
        let state = app.runStates.get(runId);
        if (!state) {
            const chatId = app.history.resolveChatIdForRun(runId) || app.activeChatId;
            state = {
                runId,
                chatId,
                messageElement: null,
                assistantSegmentElement: null,
                assistantSegmentText: '',
                toolCalls: new Map(),
                todoState: null
            };
            app.runStates.set(runId, state);
        } else if (!state.chatId) {
            state.chatId = app.history.resolveChatIdForRun(runId) || app.activeChatId;
        }
        return state;
    }

    isRunActiveChat(runId) {
        const state = this.getRunState(runId);
        return Boolean(state && state.chatId && state.chatId === this.app.activeChatId);
    }

    getOrCreateRunMessageElement(runId, state) {
        const app = this.app;
        if (!state) return null;
        if (!state.messageElement) {
            state.messageElement = this.createMessageElement('assistant');
        }
        if (state.chatId && state.chatId === app.activeChatId && !state.messageElement.isConnected) {
            app.elements.messages.appendChild(state.messageElement);
        }
        if (state.chatId && state.chatId === app.activeChatId) {
            app.currentMessageElement = state.messageElement;
        }
        return state.messageElement;
    }

    closeAssistantSegment(state) {
        if (!state) return;
        state.assistantSegmentElement = null;
        state.assistantSegmentText = '';
    }

    getOrCreateAssistantSegmentElement(messageElement, state) {
        const contentElement = messageElement.querySelector('.message-text');
        if (!state.assistantSegmentElement) {
            const segment = document.createElement('div');
            segment.className = 'assistant-markdown assistant-segment';
            contentElement.appendChild(segment);
            state.assistantSegmentElement = segment;
            state.assistantSegmentText = '';
        }
        return state.assistantSegmentElement;
    }

    attachRunMessagesForChat(chatId) {
        const app = this.app;
        if (!chatId) return;
        let lastMessageElement = null;
        for (const state of app.runStates.values()) {
            if (state.chatId !== chatId || !state.messageElement) continue;
            if (!state.messageElement.isConnected) {
                app.elements.messages.appendChild(state.messageElement);
            }
            lastMessageElement = state.messageElement;
        }
        if (lastMessageElement) {
            app.currentMessageElement = lastMessageElement;
        }
    }

    getMessagePayloadFromElement(messageElement) {
        if (!messageElement) return { content: '', html: '' };
        const textElement = messageElement.querySelector('.message-text');
        return {
            content: textElement ? textElement.textContent : '',
            html: textElement ? textElement.innerHTML : ''
        };
    }

    saveRunStateToHistory(runId, status) {
        const app = this.app;
        const state = app.runStates.get(runId);
        if (!state || !state.chatId) return;

        const index = app.history.findChatIndex({ id: state.chatId, runId });
        const existing = index >= 0 ? app.chatHistory[index] : null;
        const messages = Array.isArray(existing?.messages) ? [...existing.messages] : [];

        if (state.messageElement) {
            const payload = this.getMessagePayloadFromElement(state.messageElement);
            if (payload.content || payload.html) {
                const last = messages[messages.length - 1];
                if (last && last.role === 'assistant' && !last.content && !last.html) {
                    messages[messages.length - 1] = { role: 'assistant', ...payload };
                } else {
                    messages.push({ role: 'assistant', ...payload });
                }
            }
        }

        app.history.upsertChatRecord({
            id: state.chatId,
            taskId: state.chatId,
            runId: runId,
            sessionId: existing?.sessionId || app.sessionId || null,
            status: status,
            messages: messages,
        });
    }

    /**
     * 完成运行状态的清理工作
     * @param {string} runId - 运行 ID
     * @param {string} status - 最终状态 (completed, failed, cancelled, rejected)
     */
    finalizeRunState(runId, status) {
        const app = this.app;
        if (!runId) return;

        // 保存运行状态到历史记录
        this.saveRunStateToHistory(runId, status);

        // 隐藏思考指示器
        const state = app.runStates.get(runId);
        if (state && state.messageElement) {
            this.hideThinkingIndicator(state.messageElement);
        }

        // 关闭当前助手文本段落
        this.closeAssistantSegment(state);

        // 清理消息缓冲区
        app.messageBuffer.delete(runId);
    }

    updateConnectionStatus(status) {
        const app = this.app;
        const statusElement = app.elements.connectionStatus;
        const textElement = statusElement.querySelector('.status-text');

        statusElement.classList.remove('connected', 'connecting', 'disconnected');

        switch (status) {
            case 'connected':
                statusElement.classList.add('connected');
                textElement.textContent = '已连接';
                break;
            case 'connecting':
                statusElement.classList.add('connecting');
                textElement.textContent = '连接中...';
                break;
            default:
                textElement.textContent = '未连接';
        }
    }

    adjustTextareaHeight() {
        const app = this.app;
        const textarea = app.elements.userInput;
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
    }

    updateSendButton() {
        const app = this.app;
        const hasText = app.elements.userInput.value.trim().length > 0;
        const isLoggedIn = app.auth.isAuthenticated();
        app.elements.sendBtn.disabled = !isLoggedIn || (!hasText && !app.isRunning);

        if (app.isRunning) {
            app.elements.sendBtn.classList.add('stop');
            app.elements.sendBtn.innerHTML = `
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                </svg>
            `;
        } else {
            app.elements.sendBtn.classList.remove('stop');
            app.elements.sendBtn.innerHTML = `
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5"></line>
                    <polyline points="5 12 12 5 19 12"></polyline>
                </svg>
            `;
        }
    }

    updateCancelButton(isRunning) {
        const app = this.app;
        if (app.elements.cancelBtn) {
            app.elements.cancelBtn.disabled = !isRunning;
        }
    }

    updateInputState() {
        const app = this.app;
        const isLoggedIn = app.auth.isAuthenticated();
        if (app.elements.userInput) {
            app.elements.userInput.disabled = !isLoggedIn;
            if (!isLoggedIn) {
                app.elements.userInput.placeholder = '请先登录';
            } else {
                app.elements.userInput.placeholder = app.defaultInputPlaceholder || '请输入需要我为您完成的任务或想要咨询的问题，Ctrl+Enter键发送';
            }
        }
        if (app.elements.attachBtn) {
            app.elements.attachBtn.disabled = !isLoggedIn;
        }
        this.updateSendButton();
    }

    async handleAttachmentUpload(files) {
        const app = this.app;
        if (!files.length) return;
        if (!app.auth.isAuthenticated()) {
            app.auth.setLoginStatus('请先登录', 'error');
            return;
        }
        if (app.elements.attachBtn) {
            app.elements.attachBtn.disabled = true;
        }
        try {
            await app.network.ensureSession();
            const result = await app.network.uploadAttachments(files);
            const uploaded = result?.files || [];
            const success = uploaded.filter(item => item.status === 'ok');
            const failed = uploaded.filter(item => item.status !== 'ok');
            if (success.length) {
                const names = success.map(item => item.filename).join('，');
                app.ui.addLogMessage('info', `附件上传成功：${names}`);
            }
            uploaded.forEach((item, index) => {
                if (item.status !== 'ok') return;
                const sourceFile = files[index];
                this.addAttachmentPreview({
                    fileId: item.file_id,
                    filename: item.filename,
                    contentType: item.content_type || sourceFile?.type || '',
                    size: item.size,
                    file: sourceFile || null,
                });
            });
            if (failed.length) {
                failed.forEach(item => {
                    const msg = item.error || '上传失败';
                    app.ui.addLogMessage('error', `附件上传失败：${item.filename || '未知文件'}（${msg}）`);
                });
            }
        } catch (error) {
            app.ui.addLogMessage('error', `附件上传失败：${error.message || error}`);
        } finally {
            if (app.elements.attachBtn) {
                app.elements.attachBtn.disabled = false;
            }
        }
    }

    isImageAttachment(contentType, filename) {
        if (contentType && contentType.startsWith('image/')) return true;
        const lowerName = (filename || '').toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif', '.tiff', '.tif'].some(ext => lowerName.endsWith(ext));
    }

    addAttachmentPreview({ fileId, filename, contentType, size, file }) {
        const app = this.app;
        if (!app.elements.attachmentPreview || !fileId) return;
        if (this.attachmentItems.has(fileId)) return;

        const item = document.createElement('div');
        item.className = 'attachment-item';
        item.setAttribute('data-file-id', fileId);
        item.setAttribute('data-filename', filename || '');

        const visual = document.createElement('div');
        visual.className = 'attachment-visual';

        let previewUrl = null;
        const isImage = this.isImageAttachment(contentType, filename);
        if (isImage && file instanceof File) {
            previewUrl = URL.createObjectURL(file);
            const img = document.createElement('img');
            img.className = 'attachment-thumb';
            img.src = previewUrl;
            img.alt = filename || 'image';
            visual.appendChild(img);
        } else {
            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('viewBox', '0 0 24 24');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', 'currentColor');
            icon.setAttribute('stroke-width', '2');
            icon.setAttribute('stroke-linecap', 'round');
            icon.setAttribute('stroke-linejoin', 'round');
            icon.classList.add('attachment-file-icon');
            icon.innerHTML = `
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
            `;
            visual.appendChild(icon);
        }

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'attachment-remove';
        removeBtn.setAttribute('data-file-id', fileId);
        removeBtn.setAttribute('aria-label', '删除附件');
        removeBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        `;

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'attachment-name';
        nameEl.textContent = filename || '未命名文件';
        meta.appendChild(nameEl);

        const sizeLabel = app.utils.formatFileSize(size);
        if (sizeLabel) {
            const sizeEl = document.createElement('div');
            sizeEl.className = 'attachment-size';
            sizeEl.textContent = sizeLabel;
            meta.appendChild(sizeEl);
        }

        item.appendChild(visual);
        item.appendChild(meta);
        item.appendChild(removeBtn);
        app.elements.attachmentPreview.appendChild(item);

        this.attachmentItems.set(fileId, { element: item, previewUrl, filename: filename || '' });
        this.updateAttachmentLayout();
    }

    async handleAttachmentRemove(fileId) {
        const app = this.app;
        const record = this.attachmentItems.get(fileId);
        if (!record) return;
        const removeBtn = record.element.querySelector('.attachment-remove');
        if (removeBtn) removeBtn.disabled = true;
        try {
            await app.network.deleteAttachment(fileId);
            this.removeAttachmentPreview(fileId);
            if (record.filename) {
                app.ui.addLogMessage('info', `附件已删除：${record.filename}`);
            }
        } catch (error) {
            if (removeBtn) removeBtn.disabled = false;
            app.ui.addLogMessage('error', `附件删除失败：${error.message || error}`);
        }
    }

    removeAttachmentPreview(fileId) {
        const record = this.attachmentItems.get(fileId);
        if (!record) return;
        if (record.previewUrl) {
            URL.revokeObjectURL(record.previewUrl);
        }
        record.element.remove();
        this.attachmentItems.delete(fileId);
        this.updateAttachmentLayout();
    }

    clearAttachmentPreviews() {
        for (const fileId of Array.from(this.attachmentItems.keys())) {
            this.removeAttachmentPreview(fileId);
        }
        this.updateAttachmentLayout();
    }

    updateAttachmentLayout() {
        const app = this.app;
        const preview = app.elements.attachmentPreview;
        const textarea = app.elements.userInput;
        const inputWrapper = app.elements.inputWrapper;
        if (!preview || !textarea || !inputWrapper) return;
        const hasAttachments = preview.children.length > 0;
        if (!hasAttachments) {
            inputWrapper.style.removeProperty('--input-padding-top');
            return;
        }
        const basePadding = 18;
        const spacing = 8;
        const previewHeight = preview.offsetHeight || 0;
        inputWrapper.style.setProperty('--input-padding-top', `${basePadding + previewHeight + spacing}px`);
    }

    isViewOnlyMode() {
        return false;
    }

    resetChatView() {
        const app = this.app;
        app.elements.messages.innerHTML = '';
        app.currentMessageElement = null;
        app.currentAssistantSegmentElement = null;
        app.currentAssistantSegmentText = '';
        app.currentToolCalls.clear();
        app.todoState = null;
        this.clearAttachmentPreviews();
    }

    scrollToBottom() {
        const app = this.app;
        app.elements.chatContainer.scrollTop = app.elements.chatContainer.scrollHeight;
    }

    showInterruptModal(interrupt) {
        const app = this.app;
        const { actions } = interrupt;

        app.elements.interruptModalBody.innerHTML = `
            <p>以下操作需要您的批准：</p>
            <div class="interrupt-actions">
                ${actions.map((action, index) => `
                    <div class="interrupt-action" data-index="${index}">
                        <div class="interrupt-action-header">
                            <svg class="interrupt-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                            </svg>
                            <div>
                                <div class="interrupt-action-name">${app.utils.escapeHtml(action.name || action.type)}</div>
                                ${action.description ? `<div class="interrupt-action-description">${app.utils.escapeHtml(action.description)}</div>` : ''}
                            </div>
                        </div>
                        ${action.args ? `
                            <div class="interrupt-action-args">
                                <pre>${app.utils.escapeHtml(JSON.stringify(action.args, null, 2))}</pre>
                            </div>
                        ` : ''}
                    </div>
                `).join('')}
            </div>
        `;

        app.elements.interruptModalFooter.innerHTML = `
            <button class="btn btn-secondary" id="rejectAllBtn">全部拒绝</button>
            <button class="btn btn-primary" id="approveAllBtn">全部批准</button>
        `;

        document.getElementById('approveAllBtn').addEventListener('click', () => {
            app.network.send({
                type: 'interrupt_response',
                interrupt_id: interrupt.id,
                approved: true
            });
            app.elements.interruptModal.classList.remove('active');
        });

        document.getElementById('rejectAllBtn').addEventListener('click', () => {
            app.network.send({
                type: 'interrupt_response',
                interrupt_id: interrupt.id,
                approved: false
            });
            app.elements.interruptModal.classList.remove('active');
        });

        app.elements.interruptModal.classList.add('active');
    }

    renderToolCall(toolCall, state) {
        const app = this.app;
        const { id, name, args, status, result } = toolCall;

        let toolElement = state?.toolCalls?.get(id);
        if (!toolElement) {
            toolElement = document.createElement('div');
            toolElement.className = 'tool-call';
            toolElement.setAttribute('data-tool-id', id);

            const header = document.createElement('div');
            header.className = 'tool-call-header';
            header.innerHTML = `
                <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>
                <div class="tool-title">
                    <span class="tool-name">${app.utils.escapeHtml(name)}</span>
                    <span class="tool-summary"></span>
                </div>
                <span class="tool-status ${status || 'pending'}">${this.getStatusLabel(status)}</span>
                <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            `;

            const body = document.createElement('div');
            body.className = 'tool-call-body';
            body.innerHTML = `
                <div class="tool-args">
                    <div class="tool-args-label">参数</div>
                    <div class="tool-args-content">${app.utils.escapeHtml(JSON.stringify(args, null, 2))}</div>
                </div>
                <div class="tool-result">
                    <div class="tool-result-label">结果</div>
                    <div class="tool-result-content">${result ? app.utils.escapeHtml(typeof result === 'string' ? result : JSON.stringify(result, null, 2)) : '等待中...'}</div>
                </div>
            `;

            header.addEventListener('click', () => {
                toolElement.classList.toggle('expanded');
            });

            toolElement.appendChild(header);
            toolElement.appendChild(body);

            if (state?.toolCalls) {
                state.toolCalls.set(id, toolElement);
            }
        } else {
            const statusElement = toolElement.querySelector('.tool-status');
            if (statusElement) {
                statusElement.className = `tool-status ${status || 'pending'}`;
                statusElement.textContent = this.getStatusLabel(status);
            }

            if (result) {
                const resultContent = toolElement.querySelector('.tool-result-content');
                if (resultContent) {
                    resultContent.textContent = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
                }
            }
        }

        return toolElement;
    }

    getStatusLabel(status) {
        const labels = {
            'running': '执行中',
            'success': '成功',
            'error': '失败',
            'pending': '等待中'
        };
        return labels[status] || status || '等待中';
    }

    /**
     * 创建工具调用元素
     * @param {Object} options - 工具调用选项
     * @param {string} options.name - 工具名称
     * @param {Object} options.args - 工具参数
     * @param {string} options.id - 工具调用 ID
     * @param {string} options.status - 工具状态 (running, success, error, pending)
     * @param {Object|null} options.todoState - TODO 状态
     * @param {string|null} options.displayTitle - 显示标题
     * @param {string|null} options.displayContent - 显示内容
     * @returns {HTMLElement} 创建的工具调用元素
     */
    createToolCallElement({ name, args, id, status, todoState, displayTitle, displayContent }) {
        const app = this.app;
        const toolElement = document.createElement('div');
        toolElement.className = 'tool-call';
        if (id) {
            toolElement.setAttribute('data-tool-id', id);
        }

        const { title, content } = app.utils.formatToolDisplay(name, args, todoState, displayTitle, displayContent);

        const header = document.createElement('div');
        header.className = 'tool-call-header';
        header.innerHTML = `
            <svg class="tool-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
            </svg>
            <div class="tool-title">
                <span class="tool-name">${app.utils.escapeHtml(title)}</span>
                <span class="tool-summary">${app.utils.escapeHtml(content)}</span>
            </div>
            <span class="tool-status ${status || 'pending'}">${this.getStatusLabel(status)}</span>
            <svg class="tool-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
        `;

        const body = document.createElement('div');
        body.className = 'tool-call-body';
        body.innerHTML = `
            <div class="tool-args">
                <div class="tool-args-label">参数</div>
                <div class="tool-args-content">${app.utils.escapeHtml(JSON.stringify(args, null, 2))}</div>
            </div>
            <div class="tool-result">
                <div class="tool-result-label">结果</div>
                <div class="tool-result-content">等待中...</div>
            </div>
        `;

        header.addEventListener('click', () => {
            toolElement.classList.toggle('expanded');
        });

        toolElement.appendChild(header);
        toolElement.appendChild(body);

        return toolElement;
    }

    /**
     * 更新工具调用元素
     * @param {HTMLElement} toolElement - 要更新的工具调用元素
     * @param {Object} options - 更新选项
     * @param {string} options.name - 工具名称
     * @param {Object} options.args - 工具参数
     * @param {string} options.status - 工具状态
     * @param {Object|null} options.todoState - TODO 状态
     * @param {string|null} options.displayTitle - 显示标题
     * @param {string|null} options.displayContent - 显示内容
     */
    updateToolCallElement(toolElement, { name, args, status, todoState, displayTitle, displayContent }) {
        if (!toolElement) return;
        const app = this.app;

        const { title, content } = app.utils.formatToolDisplay(name, args, todoState, displayTitle, displayContent);

        // 更新工具名称
        const toolNameElement = toolElement.querySelector('.tool-name');
        if (toolNameElement) {
            toolNameElement.textContent = title;
        }

        // 更新工具摘要
        const toolSummaryElement = toolElement.querySelector('.tool-summary');
        if (toolSummaryElement) {
            toolSummaryElement.textContent = content;
        }

        // 更新状态
        const statusElement = toolElement.querySelector('.tool-status');
        if (statusElement) {
            statusElement.className = `tool-status ${status || 'pending'}`;
            statusElement.textContent = this.getStatusLabel(status);
        }

        // 更新参数
        const argsContent = toolElement.querySelector('.tool-args-content');
        if (argsContent && args) {
            argsContent.textContent = JSON.stringify(args, null, 2);
        }
    }

    renderFileOperation(fileOp) {
        const app = this.app;
        const { path, operation, status, content, diff, metrics } = fileOp;

        const fileElement = document.createElement('div');
        fileElement.className = 'file-operation';

        const hasExpandableContent = content || diff;

        const header = document.createElement('div');
        header.className = 'file-operation-header';
        if (hasExpandableContent) {
            header.setAttribute('onclick', '');
        }
        header.innerHTML = `
            <svg class="file-op-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="file-op-path">${app.utils.escapeHtml(path)}</span>
            <span class="file-op-status ${status || ''}">${operation || ''}</span>
            ${hasExpandableContent ? `
                <svg class="file-op-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            ` : ''}
        `;

        fileElement.appendChild(header);

        if (hasExpandableContent) {
            const body = document.createElement('div');
            body.className = 'file-operation-body';

            if (metrics) {
                body.innerHTML += `
                    <div class="file-op-metrics">
                        ${metrics.lines ? `<span>行数: ${metrics.lines}</span>` : ''}
                        ${metrics.size ? `<span>大小: ${metrics.size}</span>` : ''}
                    </div>
                `;
            }

            if (diff) {
                body.innerHTML += `
                    <div class="file-op-diff">
                        <pre>${this.formatDiff(diff)}</pre>
                    </div>
                `;
            }

            if (content) {
                body.innerHTML += `
                    <div class="file-op-content">
                        <div class="file-op-content-label">内容</div>
                        <pre><code>${app.utils.escapeHtml(content)}</code></pre>
                    </div>
                `;
            }

            fileElement.appendChild(body);

            header.addEventListener('click', () => {
                fileElement.classList.toggle('expanded');
            });
        }

        return fileElement;
    }

    formatDiff(diff) {
        const app = this.app;
        return diff.split('\n').map(line => {
            if (line.startsWith('+')) {
                return `<span class="diff-add">${app.utils.escapeHtml(line)}</span>`;
            } else if (line.startsWith('-')) {
                return `<span class="diff-remove">${app.utils.escapeHtml(line)}</span>`;
            } else if (line.startsWith('@@')) {
                return `<span class="diff-header">${app.utils.escapeHtml(line)}</span>`;
            }
            return app.utils.escapeHtml(line);
        }).join('\n');
    }

    renderTodoList(todoData, state) {
        const app = this.app;
        if (!todoData || !todoData.items) return null;

        const { title, items, progress } = todoData;

        let todoElement = state?.todoElement;
        if (!todoElement) {
            todoElement = document.createElement('div');
            todoElement.className = 'todo-list expanded';

            const header = document.createElement('div');
            header.className = 'todo-list-header';
            header.innerHTML = `
                <div class="todo-header-text">
                    <span class="todo-title">${app.utils.escapeHtml(title || '任务列表')}</span>
                    <div class="todo-badges">
                        <div class="todo-progress-chips"></div>
                    </div>
                </div>
                <svg class="todo-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            `;

            const itemsContainer = document.createElement('div');
            itemsContainer.className = 'todo-items';

            header.addEventListener('click', () => {
                todoElement.classList.toggle('expanded');
            });

            todoElement.appendChild(header);
            todoElement.appendChild(itemsContainer);

            if (state) {
                state.todoElement = todoElement;
            }
        }

        const progressChips = todoElement.querySelector('.todo-progress-chips');
        if (progressChips && progress) {
            const completedCount = items.filter(item => item.completed).length;
            const totalCount = items.length;
            const progressClass = completedCount === totalCount ? 'completed' : (completedCount > 0 ? 'started' : '');
            progressChips.innerHTML = `
                <span class="todo-progress ${progressClass}">${completedCount}/${totalCount}</span>
            `;
        }

        const itemsContainer = todoElement.querySelector('.todo-items');
        itemsContainer.innerHTML = items.map((item, index) => `
            <div class="todo-item ${item.completed ? 'completed' : ''}">
                <input type="checkbox" class="todo-checkbox" ${item.completed ? 'checked' : ''} disabled>
                <span class="todo-text">${app.utils.escapeHtml(item.text)}</span>
            </div>
        `).join('');

        return todoElement;
    }
    
    /**
     * 添加日志消息到聊天界面
     * @param {string} level - 日志级别 (info, warning, error, success)
     * @param {string} message - 日志消息内容
     * @param {string|null} runId - 可选的 run ID
     * @returns {HTMLElement} 创建的日志元素
     */
    addLogMessage(level, message, runId = null) {
        const app = this.app;
        const logElement = document.createElement('div');
        logElement.className = `log-message ${level || 'info'}`;
        logElement.textContent = `[${app.utils.formatLogLevel(level)}] ${message}`;
        
        // 如果有 runId，尝试添加到对应的消息元素中
        if (runId) {
            const state = this.getRunState(runId);
            if (state && state.messageElement) {
                const contentElement = state.messageElement.querySelector('.message-text');
                if (contentElement) {
                    contentElement.appendChild(logElement);
                    this.scrollToBottom();
                    return logElement;
                }
            }
        }
        
        // 否则添加到消息列表末尾
        app.elements.messages.appendChild(logElement);
        this.scrollToBottom();
        return logElement;
    }

    /**
     * 显示重连通知
     * @param {number} attemptCount - 当前重连尝试次数
     * @param {number} maxAttempts - 最大重连尝试次数
     */
    showReconnectNotice(attemptCount, maxAttempts) {
        const app = this.app;
        // 如果已有重连通知元素，更新它
        if (app.reconnectLogElement && app.reconnectLogElement.isConnected) {
            app.reconnectLogElement.textContent = `[${app.utils.formatLogLevel('info')}] 正在尝试重连…（${attemptCount}/${maxAttempts}）`;
            return;
        }
        // 创建新的重连通知元素
        app.reconnectLogElement = this.addLogMessage('info', `正在尝试重连…（${attemptCount}/${maxAttempts}）`);
    }

    /**
     * 隐藏重连通知
     */
    hideReconnectNotice() {
        const app = this.app;
        if (app.reconnectLogElement && app.reconnectLogElement.isConnected) {
            app.reconnectLogElement.remove();
        }
        app.reconnectLogElement = null;
    }

    // Theme toggle method
    toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('cortexai-theme', newTheme);
        
        // Update user avatars based on new theme
        this.updateUserAvatars(newTheme);
    }
    
    // Update all user avatars when theme changes
    // Now using the same avatar for both themes, background is controlled by CSS
    updateUserAvatars(theme) {
        // No need to change avatar src anymore since we use the same image
        // Background color changes are handled by CSS
    }

    /**
     * 创建文件操作元素
     * @param {Object} options - 文件操作选项
     * @param {string} options.toolName - 工具名称
     * @param {string} options.path - 文件路径
     * @param {string} options.status - 操作状态
     * @param {string} options.error - 错误信息
     * @param {Object} options.metrics - 文件指标
     * @param {string} options.diff - 文件差异
     * @param {string} options.content - 文件内容
     * @param {boolean} options.contentTruncated - 内容是否被截断
     * @param {Object} options.meta - 元数据
     * @returns {HTMLElement} 创建的文件操作元素
     */
    createFileOpElement({ toolName, path, status, error, metrics, diff, content, contentTruncated, meta }) {
        const app = this.app;
        const fileElement = document.createElement('div');
        fileElement.className = 'file-operation';

        const hasExpandableContent = content || diff;
        const operation = this.getFileOpLabel(toolName);
        const statusLabel = app.utils.formatFileOpStatus(status);

        const header = document.createElement('div');
        header.className = 'file-operation-header';
        header.innerHTML = `
            <svg class="file-op-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
            </svg>
            <span class="file-op-path">${app.utils.escapeHtml(path || '')}</span>
            <span class="file-op-status ${status || ''}">${app.utils.escapeHtml(operation)} - ${app.utils.escapeHtml(statusLabel)}</span>
            ${hasExpandableContent ? `
                <svg class="file-op-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            ` : ''}
        `;

        fileElement.appendChild(header);

        if (hasExpandableContent) {
            const body = document.createElement('div');
            body.className = 'file-operation-body';

            if (error) {
                body.innerHTML += `
                    <div class="file-op-error">
                        <div class="file-op-error-label">错误</div>
                        <div class="file-op-error-content">${app.utils.escapeHtml(error)}</div>
                    </div>
                `;
            }

            if (metrics) {
                body.innerHTML += `
                    <div class="file-op-metrics">
                        ${metrics.lines ? `<span>行数: ${metrics.lines}</span>` : ''}
                        ${metrics.size ? `<span>大小: ${metrics.size}</span>` : ''}
                    </div>
                `;
            }

            if (diff) {
                body.innerHTML += `
                    <div class="file-op-diff">
                        <pre>${this.formatDiff(diff)}</pre>
                    </div>
                `;
            }

            if (content) {
                body.innerHTML += `
                    <div class="file-op-content">
                        <div class="file-op-content-label">内容${contentTruncated ? '（已截断）' : ''}</div>
                        <pre><code>${app.utils.escapeHtml(content)}</code></pre>
                    </div>
                `;
            }

            fileElement.appendChild(body);

            header.addEventListener('click', () => {
                fileElement.classList.toggle('expanded');
            });
        }

        return fileElement;
    }

    /**
     * 获取文件操作标签
     * @param {string} toolName - 工具名称
     * @returns {string} 操作标签
     */
    getFileOpLabel(toolName) {
        const labels = {
            'read_file': '读取文件',
            'write_file': '创建文件',
            'edit_file': '编辑文件',
            'delete_file': '删除文件',
            'copy_file': '复制文件',
            'move_file': '移动文件',
        };
        return labels[toolName] || toolName || '文件操作';
    }

    /**
     * 创建待办事项列表元素
     * @param {Array} todos - 待办事项列表
     * @param {Array|null} prevTodos - 上一次的待办事项列表
     * @returns {HTMLElement} 创建的待办事项列表元素
     */
    createTodoListElement(todos, prevTodos = null) {
        const app = this.app;
        const todoElement = document.createElement('div');
        todoElement.className = 'todo-list expanded';
        todoElement.innerHTML = app.utils.renderTodoListHtml(todos, prevTodos);
        return todoElement;
    }

    /**
     * 完成过期的运行状态
     * @param {string} currentRunId - 当前运行 ID
     */
    finalizeStaleRunStatuses(currentRunId) {
        const app = this.app;
        // 找到所有运行中的状态元素，将不是当前运行的标记为已完成
        const runningElements = document.querySelectorAll('.run-status.running, .run-status.queued');
        runningElements.forEach(element => {
            const runId = element.getAttribute('data-run-id');
            if (runId && runId !== currentRunId) {
                element.className = 'run-status completed';
                element.innerHTML = `<span>${app.utils.formatRunStatus('completed')}</span>`;
            }
        });
    }

    /**
     * 同步运行状态元素
     * @param {string} runId - 运行 ID
     * @param {string} status - 运行状态
     * @param {Object} options - 选项
     * @param {boolean} options.createIfMissing - 如果不存在是否创建
     */
    syncRunStatusElement(runId, status, options = {}) {
        const app = this.app;
        const { createIfMissing = false } = options;

        // 尝试找到已存在的状态元素
        let statusElement = app.runStatusElements.get(runId);

        if (!statusElement && createIfMissing) {
            // 创建新的状态元素
            statusElement = document.createElement('div');
            statusElement.className = `run-status ${status}`;
            statusElement.setAttribute('data-run-id', runId);
            statusElement.innerHTML = `<span>${app.utils.formatRunStatus(status)}</span>`;

            // 添加到消息列表
            app.elements.messages.appendChild(statusElement);
            app.runStatusElements.set(runId, statusElement);
            app.currentRunStatusElement = statusElement;
        } else if (statusElement) {
            // 更新已存在的状态元素
            statusElement.className = `run-status ${status}`;
            statusElement.innerHTML = `<span>${app.utils.formatRunStatus(status)}</span>`;
        }

        return statusElement;
    }
}
