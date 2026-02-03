/** @typedef {import('../app.js').DeepAgentsClient} DeepAgentsClient */

export class MessageModule {
    /** @param {DeepAgentsClient} app */
    constructor(app) {
        /** @type {DeepAgentsClient} */
        this.app = app;
    }

    handleMessage(data) {
        const app = this.app;
        app.network.logClient('ws_message_received', { data });

        const eventType = data.type;

        switch (eventType) {
            case 'run.queued':
                this.handleRunQueued(data);
                break;
            case 'run.started':
                this.handleRunStarted(data);
                break;
            case 'run.completed':
            case 'run.failed':
            case 'run.cancelled':
            case 'run.rejected':
                this.handleRunEnded(data);
                break;
            case 'run.status':
                this.handleRunStatus(data);
                break;
            case 'assistant.delta':
                this.handleAssistantDelta(data);
                break;
            case 'assistant.message':
                this.handleAssistantMessage(data);
                break;
            case 'tool.call.started':
                this.handleToolCallStarted(data);
                break;
            case 'tool.call.ended':
                this.handleToolCallEnded(data);
                break;
            case 'file.op':
                this.handleFileOp(data);
                break;
            case 'todos.updated':
                this.handleTodosUpdated(data);
                break;
            case 'interrupt.request':
                this.handleInterruptRequest(data);
                break;
            case 'interrupt.auto_approved':
                this.handleInterruptAutoApproved(data);
                break;
            case 'session.auto_approve':
                this.handleSessionAutoApprove(data);
                break;
            case 'log':
                this.handleLog(data);
                break;
            default:
                console.log('未知事件类型：', eventType, data);
        }
    }

    handleRunQueued(data) {
        const app = this.app;
        console.log('任务已排队：', data.run_id);
        app.network.logClient('run_queued', { runId: data.run_id });
        if (!app.currentRunId) {
            app.currentRunId = data.run_id;
        }
        app.currentRunStatus = 'queued';
        if (data.run_id && app.activeChatId && !app.runIdToChatId.has(data.run_id)) {
            app.runIdToChatId.set(data.run_id, app.activeChatId);
        }
        app.history.updateChatStatus(data.run_id, 'queued');
        // 已删除运行状态提示元素
    }

    handleRunStarted(data) {
        const app = this.app;
        console.log('任务开始：', data.run_id);
        app.network.logClient('run_started', { runId: data.run_id });
        app.currentRunId = data.run_id;
        app.currentRunStatus = 'running';
        app.cancelRequested = false;
        app.pendingCancelLogElement = null;
        if (data.run_id && app.activeChatId && !app.runIdToChatId.has(data.run_id)) {
            app.runIdToChatId.set(data.run_id, app.activeChatId);
        }
        const isActiveChatRun = app.ui.isRunActiveChat(data.run_id);
        app.isRunning = true;
        app.ui.updateCancelButton(true);
        app.ui.updateSendButton();
        app.messageBuffer.set(data.run_id, '');
        app.currentAssistantSegmentElement = null;
        app.currentAssistantSegmentText = '';

        if (isActiveChatRun) {
            app.elements.welcomeMessage.style.display = 'none';
            // 已删除运行状态提示元素
        }
        app.history.updateChatStatus(data.run_id, 'running');
    }

    handleRunEnded(data) {
        const app = this.app;
        const status = data.type.split('.')[1];
        console.log('任务结束：', status, data);
        app.network.logClient('run_ended', { runId: data.run_id || app.currentRunId, status });

        const runId = data.run_id || app.currentRunId;
        if (runId) {
            app.currentRunStatus = status;
            app.history.updateChatStatus(runId, status);
        }
        if (status === 'cancelled' && app.pendingCancelLogElement && app.pendingCancelLogElement.isConnected) {
            app.pendingCancelLogElement.textContent = `[${app.utils.formatLogLevel('info')}] 已取消`;
        }
        app.cancelRequested = false;
        app.pendingCancelLogElement = null;

        if (!app.currentRunId || runId === app.currentRunId) {
            app.currentRunId = null;
            app.isRunning = false;
            app.ui.updateCancelButton(false);
            app.ui.updateSendButton();
            app.currentAssistantSegmentElement = null;
            app.currentAssistantSegmentText = '';
        }

        // 已删除运行状态提示元素更新代码

        if (runId) {
            app.ui.finalizeRunState(runId, status);
        }

        if (app.typingIndicator) {
            app.typingIndicator.remove();
            app.typingIndicator = null;
        }
    }

    handleRunStatus(data) {
        const app = this.app;
        const runId = data.run_id;
        const status = data.status;
        if (!runId || !status || status === 'unknown') return;

        if (app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }
        const isActiveChatRun = app.ui.isRunActiveChat(runId);
        app.history.updateChatStatus(runId, status);
        if (status === 'cancelled' && app.pendingCancelLogElement && app.pendingCancelLogElement.isConnected) {
            app.pendingCancelLogElement.textContent = `[${app.utils.formatLogLevel('info')}] 已取消`;
        }
        // 已删除运行状态提示元素相关代码

        if (app.currentRunId && runId === app.currentRunId) {
            app.currentRunStatus = status;
            const active = app.utils.isActiveRunStatus(status);
            app.isRunning = active;
            app.ui.updateCancelButton(active);
            app.ui.updateSendButton();
            if (!active) {
                app.cancelRequested = false;
                app.pendingCancelLogElement = null;
                app.currentRunId = null;
            }
        }
    }

    handleAssistantDelta(data) {
        const app = this.app;
        this.appendAssistantText(data.run_id || app.currentRunId || 'default', data.text);
    }

    handleAssistantMessage(data) {
        const app = this.app;
        this.appendAssistantText(data.run_id || app.currentRunId || 'default', data.text);
    }

    handleToolCallStarted(data) {
        const app = this.app;
        const { tool_name, args, tool_call_id, display_title, display_content } = data;

        if (tool_name == 'write_file') {
            app.network.logClient('tool_call_started', { data: data });
        }

        const runId = data.run_id || app.currentRunId || 'default';
        const state = app.ui.getRunState(runId);
        app.ui.closeAssistantSegment(state);

        // 工具调用时先隐藏思考动效，稍后在工具元素后重新显示
        if (state?.messageElement) {
            app.ui.hideThinkingIndicator(state.messageElement);
        }

        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            const toolElement = state.toolCalls.get(tool_call_id);
            app.ui.updateToolCallElement(toolElement, {
                name: tool_name,
                args,
                status: 'running',
                todoState: state?.todoState || null,
                displayTitle: display_title,
                displayContent: display_content,
            });
            if (state.chatId === app.activeChatId) {
                app.ui.scrollToBottom();
            }
            return;
        }

        const toolElement = app.ui.createToolCallElement({
            name: tool_name,
            args: args,
            id: tool_call_id,
            status: 'running',
            todoState: state?.todoState || null,
            displayTitle: display_title,
            displayContent: display_content,
        });

        const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(toolElement);

        // 工具元素添加后，在最下方重新显示思考动效
        app.ui.showThinkingIndicator(messageElement);

        if (tool_call_id && state) {
            state.toolCalls.set(tool_call_id, toolElement);
        }

        if (state?.chatId === app.activeChatId) {
            app.ui.scrollToBottom();
        }
    }

    handleToolCallEnded(data) {
        const app = this.app;
        const { tool_name, status, tool_call_id, content_preview, content, display_title, display_content } = data;
        const toolContent = typeof content === 'string' && content.length ? content : content_preview;
        const runId = data.run_id || app.currentRunId || 'default';
        const state = app.ui.getRunState(runId);

        let toolElement = null;
        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            toolElement = state.toolCalls.get(tool_call_id);
        } else {
            app.ui.closeAssistantSegment(state);
            toolElement = app.ui.createToolCallElement({
                name: tool_name || 'tool',
                args: {},
                id: tool_call_id,
                status: status || 'success',
                todoState: state?.todoState || null,
                displayTitle: display_title,
                displayContent: display_content,
            });

            const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
            if (!messageElement) return;
            const contentElement = messageElement.querySelector('.message-text');
            contentElement.appendChild(toolElement);
        }

        const statusElement = toolElement.querySelector('.tool-status');
        if (statusElement) {
            statusElement.className = `tool-status ${status}`;
            statusElement.textContent = app.utils.formatToolStatus(status);
        }

        if (toolContent) {
            const bodyElement = toolElement.querySelector('.tool-call-body');
            if (bodyElement) {
                let resultElement = bodyElement.querySelector('.tool-result');
                if (!resultElement) {
                    resultElement = document.createElement('div');
                    resultElement.className = 'tool-result';
                    resultElement.innerHTML = `
                        <div class="tool-result-label">结果</div>
                        <div class="tool-result-content"></div>
                    `;
                    bodyElement.appendChild(resultElement);
                }
                const resultContent = resultElement.querySelector('.tool-result-content');
                if (resultContent) {
                    resultContent.innerHTML = app.utils.formatToolResult(toolContent);
                }
            }
        }

        if (tool_call_id && state) state.toolCalls.delete(tool_call_id);

        // 工具调用结束后，重新在最下方显示思考动效
        const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
        if (messageElement) {
            app.ui.hideThinkingIndicator(messageElement);
            app.ui.showThinkingIndicator(messageElement);
        }

        if (state?.chatId === app.activeChatId) {
            app.ui.scrollToBottom();
        }
    }

    handleFileOp(data) {
        const app = this.app;
        const { tool_name, path, status, error, metrics, diff, content, content_preview, content_truncated, meta } = data;
        const runId = data.run_id || app.currentRunId || 'default';
        const state = app.ui.getRunState(runId);
        app.ui.closeAssistantSegment(state);

        const fileOpElement = app.ui.createFileOpElement({
            toolName: tool_name,
            path: path,
            status: status,
            error: error,
            metrics: metrics,
            diff: diff,
            content: typeof content === 'string' && content.length ? content : content_preview,
            contentTruncated: Boolean(content_truncated),
            meta: meta || {}
        });

        const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
        if (!messageElement) return;
        const contentElement = messageElement.querySelector('.message-text');
        contentElement.appendChild(fileOpElement);

        if (state?.chatId === app.activeChatId) {
            app.ui.scrollToBottom();
        }
    }

    handleTodosUpdated(data) {
        const app = this.app;
        const todos = data.todos;
        if (!todos || !Array.isArray(todos)) return;
        const runId = data.run_id || app.currentRunId || 'default';
        const state = app.ui.getRunState(runId);

        const prevTodos = state?.todoState || null;

        let todoElement = state?.messageElement?.querySelector('.todo-list');

        if (!todoElement) {
            app.ui.closeAssistantSegment(state);
            const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
            if (!messageElement) return;

            todoElement = app.ui.createTodoListElement(todos, prevTodos);
            const contentElement = messageElement.querySelector('.message-text');
            contentElement.appendChild(todoElement);
        } else {
            todoElement.innerHTML = app.utils.renderTodoListHtml(todos, prevTodos);
        }

        if (state) {
            state.todoState = JSON.parse(JSON.stringify(todos));
        }
        if (state?.chatId === app.activeChatId) {
            app.todoState = state.todoState;
            app.ui.scrollToBottom();
        }
    }

    handleInterruptRequest(data) {
        const app = this.app;
        const { interrupt_id, request } = data;
        console.log('Interrupt request:', interrupt_id, request);

        app.pendingInterrupts.push({ interrupt_id, request, run_id: data.run_id });
        app.ui.showInterruptModal(request, interrupt_id, data.run_id);
    }

    handleInterruptAutoApproved(data) {
        try {
            console.debug('Auto-approved interrupt:', data?.interrupt_id);
        } catch {}
    }

    handleSessionAutoApprove(data) {
        const app = this.app;
        app.autoApprove = data.enabled;
        app.elements.autoApproveToggle.checked = data.enabled;
    }

    handleLog(data) {
        const app = this.app;
        const { level, message, run_id } = data;
        app.ui.addLogMessage(level || 'info', message, run_id || null);
    }

    ingestAssistantText(runId, incomingText) {
        const app = this.app;
        const text = incomingText == null ? '' : String(incomingText);
        if (!text) return '';

        const currentFull = app.messageBuffer.get(runId) || '';
        let nextFull = '';
        let appended = '';

        if (!currentFull) {
            nextFull = text;
            appended = text;
        } else if (text.startsWith(currentFull)) {
            nextFull = text;
            appended = text.slice(currentFull.length);
        } else if (currentFull.startsWith(text)) {
            nextFull = currentFull;
            appended = '';
        } else {
            nextFull = currentFull + text;
            appended = text;
        }

        app.messageBuffer.set(runId, nextFull);
        return appended;
    }

    appendAssistantText(runId, text) {
        const app = this.app;
        const appended = this.ingestAssistantText(runId, text);
        if (!appended) return;

        const state = app.ui.getRunState(runId);
        const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
        if (!messageElement || !state) return;

        // 当 AI 开始回复时，隐藏思考动效
        app.ui.hideThinkingIndicator(messageElement);

        const segmentElement = app.ui.getOrCreateAssistantSegmentElement(messageElement, state);
        state.assistantSegmentText += appended;
        segmentElement.innerHTML = app.utils.parseMarkdown(state.assistantSegmentText);
        if (state.chatId === app.activeChatId) {
            app.ui.scrollToBottom();
        }
    }

    async sendMessage() {
        const app = this.app;
        const input = app.elements.userInput.value.trim();
        if (!input || app.isRunning || app.ui.isViewOnlyMode()) return;
        if (!app.auth.isAuthenticated()) {
            app.auth.setLoginStatus('请先登录', 'error');
            return;
        }

        if (!app.sessionId) {
            try {
                await app.network.ensureSession();
            } catch {
                return;
            }
        }

        const userMessage = app.ui.createMessageElement('user');
        const attachments = app.ui.getAttachmentPayloads();
        if (attachments.length) {
            app.ui.appendMessageAttachments(userMessage, attachments);
        }
        userMessage.querySelector('.message-text').textContent = input;
        app.elements.messages.appendChild(userMessage);

        app.elements.userInput.value = '';
        if (attachments.length) {
            app.ui.clearAttachmentPreviews();
        }
        app.ui.adjustTextareaHeight();
        app.ui.updateSendButton();

        app.elements.welcomeMessage.style.display = 'none';

        app.currentAssistantSegmentElement = null;
        app.currentAssistantSegmentText = '';

        const runId = app.utils.generateRunId();
        app.currentRunId = runId;
        app.currentRunStatus = 'queued';
        if (!app.activeChatId) {
            app.activeChatId = app.utils.generateTaskId();
        }
        app.runIdToChatId.set(runId, app.activeChatId);

        // 创建 AI 消息元素并显示思考动效
        const assistantMessage = app.ui.createMessageElement('assistant');
        app.elements.messages.appendChild(assistantMessage);
        app.currentMessageElement = assistantMessage;
        app.ui.showThinkingIndicator(assistantMessage);

        // 将消息元素关联到 runState
        const state = app.ui.getRunState(runId);
        if (state) {
            state.messageElement = assistantMessage;
            state.chatId = app.activeChatId;
        }
        const title = app.history.summarizeTitleFromText(input);
        app.history.saveCurrentChat({ status: 'queued', runId, title });
        app.network.send({
            type: 'run',
            input: input,
            run_id: runId
        });
        app.network.logClient('run_sent', { runId, inputLen: input.length });
        app.network.setSessionState({ sessionId: app.sessionId, chatId: app.activeChatId, hasMessages: true });

        app.ui.scrollToBottom();
    }

    cancelRun() {
        const app = this.app;
        if (app.currentRunStatus === 'cancelled') {
            app.ui.addLogMessage('info', '已取消');
            return;
        }
        if (!app.isRunning || app.cancelRequested) return;

        app.network.send({ type: 'cancel' });
        app.cancelRequested = true;
        app.pendingCancelLogElement = app.ui.addLogMessage('info', '正在取消当前任务…');
    }

    newChat() {
        const app = this.app;
        if (!app.auth.isAuthenticated()) {
            app.auth.setLoginStatus('请先登录', 'error');
            return;
        }
        if (app.history.hasCurrentMessages()) {
            app.history.backgroundCurrentChat('new_chat');
        }
        app.ui.resetChatView();
        app.activeChatId = null;
        app.currentRunId = null;
        app.currentRunStatus = null;
        app.isRunning = false;
        app.cancelRequested = false;
        app.pendingCancelLogElement = null;
        app.ui.updateCancelButton(false);
        app.ui.updateSendButton();
        app.elements.chatTitle.textContent = '新对话';
        app.elements.welcomeMessage.style.display = 'flex';
        app.network.logClient('new_chat', { chatId: app.activeChatId, mode: 'new' });

        app.network.disconnectWebSocket({ allowReconnect: false });
        app.sessionId = null;
        app.wsUrl = null;
        app.ui.updateConnectionStatus('disconnected');
    }
}
