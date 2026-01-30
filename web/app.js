import { AuthModule } from './app/auth.js';
import { HistoryModule } from './app/history.js';
import { MessageModule } from './app/messages.js';
import { NetworkModule } from './app/network.js';
import { UiModule } from './app/ui.js';
import { UtilsModule } from './app/utils.js';

// DeepAgents Web Client
// Main application logic for WebSocket communication and UI management
export class DeepAgentsClient {
    constructor() {
        this.wsUrl = null;
        this.sessionId = null;
        this.assistantId = 'agent';

        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 2000;

        this.currentRunId = null;
        this.isRunning = false;
        this.autoApprove = true;
        this.pendingInterrupts = [];
        this.messageBuffer = new Map();
        this.currentAssistantSegmentElement = null;
        this.currentAssistantSegmentText = '';
        this.currentToolCalls = new Map();
        this.runStatusElements = new Map();
        this.currentRunStatusElement = null;
        this.sessions = [];
        this.chatHistory = [];
        this.todoState = null;
        this.activeChatId = null;
        this.runIdToChatId = new Map();
        this.currentRunStatus = null;
        this.shouldReconnect = true;
        this.pendingRunStatusId = null;
        this.reconnectLogElement = null;
        this.runStates = new Map();
        this.pendingMessages = [];
        this.cancelRequested = false;
        this.pendingCancelLogElement = null;
        this.forceReconnect = false;
        this.defaultInputPlaceholder = '';
        this.sessionCreatePromise = null;
        this.authToken = null;
        this.currentUser = null;

        this.elements = {};
        this.currentMessageElement = null;
        this.typingIndicator = null;

        /** @type {UtilsModule} */
        this.utils = new UtilsModule(this);
        /** @type {AuthModule} */
        this.auth = new AuthModule(this);
        /** @type {HistoryModule} */
        this.history = new HistoryModule(this);
        /** @type {NetworkModule} */
        this.network = new NetworkModule(this);
        /** @type {UiModule} */
        this.ui = new UiModule(this);
        /** @type {MessageModule} */
        this.messages = new MessageModule(this);

        this.serverUrl = this.network.getServerUrl();

        this.ui.init();
        this.utils.updateBridgeMeta();
    }
}

let app;
document.addEventListener('DOMContentLoaded', () => {
    app = new DeepAgentsClient();
    window.app = app;
    window.DeepAgentsClient = DeepAgentsClient;
});
