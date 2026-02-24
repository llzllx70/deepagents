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
            case 'browser.intervention.request':
                this.handleBrowserInterventionRequest(data);
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
            app.pendingCancelLogElement.textContent = `[${app.utils.formatLogLevel('info')}] 当前任务已停止`;
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
            app.pendingCancelLogElement.textContent = `[${app.utils.formatLogLevel('info')}] 当前任务已停止`;
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
        const { tool_name, args, tool_call_id, display_title, display_content, parent_tool_call_id } = data;

        if (tool_name == 'write_file') {
            app.network.logClient('tool_call_started', { data: data });
        }

        const runId = data.run_id || app.currentRunId || 'default';
        
        // 确保 runId 与当前会话关联
        if (runId && runId !== 'default' && app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }
        
        const state = app.ui.getRunState(runId);
        app.ui.closeAssistantSegment(state);

        // 工具调用时先隐藏思考动效，稍后在工具元素后重新显示
        if (state?.messageElement) {
            app.ui.hideThinkingIndicator(state.messageElement);
        }

        // 检查是否是任务列表工具
        const isTask = tool_name === 'task' || tool_name === 'write_todos';
        
        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            const toolElement = state.toolCalls.get(tool_call_id);
            
            // 对于任务列表工具，检查是否需要添加到DOM（第一次调用时未添加）
            if (isTask && !toolElement.parentElement) {
                // 第二次调用时，添加到DOM中
                const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
                if (messageElement) {
                    const contentElement = messageElement.querySelector('.message-text');
                    contentElement.appendChild(toolElement);
                    // 默认展开
                    toolElement.classList.add('expanded');
                }
            }
            
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
        
        // 对于任务列表工具，第一次调用时创建元素但不添加到DOM
        if (isTask && state) {
            const toolElement = app.ui.createToolCallElement({
                name: tool_name,
                args: args,
                id: tool_call_id,
                status: 'running',
                todoState: state?.todoState || null,
                displayTitle: display_title,
                displayContent: display_content,
            });
            // 记录到toolCalls中，但不添加到DOM（等待第二次调用时添加）
            if (tool_call_id) {
                state.toolCalls.set(tool_call_id, toolElement);
            }
            // 设置为当前任务元素，子工具会添加到其中
            state.currentTaskElement = toolElement;
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

        // 检查是否有父任务，如果有则添加到父任务的子容器中
        // 注意：任务列表工具本身不应该添加到其他任务的子容器中
        let parentContainer = null;
        let parentTaskElement = null;
        
        if (!isTask) {
            // 非任务工具才检查父容器
            if (parent_tool_call_id && state?.toolCalls?.has(parent_tool_call_id)) {
                parentTaskElement = state.toolCalls.get(parent_tool_call_id);
            }
            
            // 如果没有父任务，检查当前是否有活动的任务元素
            if (!parentTaskElement && state?.currentTaskElement) {
                parentTaskElement = state.currentTaskElement;
            }
            
            // 如果父任务元素存在但还未添加到DOM，先将其添加到DOM
            if (parentTaskElement && !parentTaskElement.isConnected) {
                const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
                if (messageElement) {
                    const contentElement = messageElement.querySelector('.message-text');
                    contentElement.appendChild(parentTaskElement);
                    // 默认展开
                    parentTaskElement.classList.add('expanded');
                }
            }
            
            if (parentTaskElement) {
                parentContainer = parentTaskElement.querySelector('.task-children');
            }
        }

        if (parentContainer) {
            // 添加到父任务的子容器中
            parentContainer.appendChild(toolElement);
            // 展开父任务以显示子工具
            if (parentTaskElement && !parentTaskElement.classList.contains('expanded')) {
                parentTaskElement.classList.add('expanded');
            }
        } else {
            const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
            if (!messageElement) return;
            const contentElement = messageElement.querySelector('.message-text');
            contentElement.appendChild(toolElement);
        }

        // 如果当前工具是任务列表，设置为当前活动任务
        if (isTask && state) {
            // 新任务开始时，自动收起上一个任务
            if (state.currentTaskElement && state.currentTaskElement !== toolElement) {
                state.currentTaskElement.classList.remove('expanded');
            }
            state.currentTaskElement = toolElement;
            // 新任务默认展开
            toolElement.classList.add('expanded');
        }

        // 工具元素添加后，在最下方重新显示思考动效
        const messageElement = app.ui.getOrCreateRunMessageElement(runId, state);
        if (messageElement) {
            app.ui.showThinkingIndicator(messageElement);
        }

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
        
        // 确保 runId 与当前会话关联
        if (runId && runId !== 'default' && app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }
        
        const state = app.ui.getRunState(runId);
        
        // 检查是否是任务列表工具
        const isTask = tool_name === 'task' || tool_name === 'write_todos';
        
        let toolElement = null;
        if (tool_call_id && state?.toolCalls?.has(tool_call_id)) {
            toolElement = state.toolCalls.get(tool_call_id);
            
            // 对于任务列表工具，如果还未添加到DOM，则跳过更新（等待第二次调用）
            if (isTask && !toolElement.parentElement) {
                // 任务列表工具还未添加到DOM，不处理结束事件
                return;
            }
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
        
        // 更新工具摘要（灰色说明文字），保持显示
        if (display_content || display_title) {
            const { content: summaryContent } = app.utils.formatToolDisplay(tool_name, {}, state?.todoState, display_title, display_content);
            const toolSummaryElement = toolElement.querySelector('.tool-summary');
            if (toolSummaryElement && summaryContent) {
                toolSummaryElement.textContent = summaryContent;
            }
        }
        if (toolContent && !isTask) {
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

        // 任务列表结束后不清除currentTaskElement，保持引用以便后续工具继续添加到该任务下
        // 只有当新任务开始时才会更新currentTaskElement

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
        
        // 确保 runId 与当前会话关联
        if (runId && runId !== 'default' && app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }
        
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
        
        // 确保 runId 与当前会话关联
        if (runId && runId !== 'default' && app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }
        
        const state = app.ui.getRunState(runId);

        const prevTodos = state?.todoState || null;

        // 更新任务抽屉（而不是在对话中展示）
        app.ui.updateTaskDrawer(todos, prevTodos);

        if (state) {
            state.todoState = JSON.parse(JSON.stringify(todos));
        }
        if (state?.chatId === app.activeChatId) {
            app.todoState = state.todoState;
        }
    }

    handleInterruptRequest(data) {
        const app = this.app;
        const { interrupt_id, request } = data;
        console.log('Interrupt request:', interrupt_id, request);

        app.pendingInterrupts.push({ interrupt_id, request, run_id: data.run_id });
        app.ui.showInterruptModal(request, interrupt_id, data.run_id);
    }

    handleBrowserInterventionRequest(data) {
        const { intervention_id, description, run_id } = data;
        console.log('Browser intervention request:', intervention_id, description);
        this.app.ui.showBrowserInterventionModal(description, intervention_id, run_id);
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

        // 确保 runId 与当前会话关联
        if (runId && runId !== 'default' && app.activeChatId && !app.runIdToChatId.has(runId)) {
            app.runIdToChatId.set(runId, app.activeChatId);
        }

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
        
        // 关闭右侧工具详情侧边栏
        app.ui.closeToolDetailSidebar();
        
        // 取消历史记录中的选中状态
        const activeItem = app.elements.historyList?.querySelector('.history-item.active');
        if (activeItem) {
            activeItem.classList.remove('active');
        }
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
