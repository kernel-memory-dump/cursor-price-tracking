import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';

interface UsageEvent {
    timestamp: string;
    date: string;
    time: string;
    model: string;
    tokens: number;
    cost: number;
    costDisplay: string; // Original cost format from API
    kind: string;
}

interface UsageSummary {
    lastUpdated: string;
    summary: {
        totalRequests: number;
        totalTokens: number;
        totalCost: number;
        totalCostDisplay: string;
    };
    byModel: Record<string, { requests: number; tokens: number; cost: number }>;
    byKind: Record<string, { requests: number; tokens: number; cost: number }>;
    recentEvents: UsageEvent[];
    activeSession?: SessionSummary | null;
}

interface SessionSummary {
    active: boolean;
    startedAt: string;
    startedAtMs: number;
    duration: string;
    summary: {
        totalRequests: number;
        totalTokens: number;
        totalCost: number;
        totalCostDisplay: string;
    };
    byModel: Record<string, { requests: number; tokens: number; cost: number }>;
    events: UsageEvent[];
}

class CostTrackingLogger {
    private static readonly DIR_NAME = '.cursor-cost-tracking';
    private static readonly SUMMARY_FILE = 'usage-summary.json';
    private static readonly LOG_FILE = 'requests.log';

    private trackingDir: string | null = null;
    private loggedTimestamps: Set<string> = new Set();
    private sessionStartMs: number | null = null;
    private lastKnownEvents: UsageEvent[] = [];

    constructor() {
        this.initTrackingDir();
        this.loadSessionState();
    }

    private initTrackingDir(): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }
        this.trackingDir = path.join(workspaceFolder.uri.fsPath, CostTrackingLogger.DIR_NAME);
    }

    private ensureDirectory(): boolean {
        if (!this.trackingDir) {
            this.initTrackingDir();
        }
        if (!this.trackingDir) {
            return false;
        }
        if (!fs.existsSync(this.trackingDir)) {
            fs.mkdirSync(this.trackingDir, { recursive: true });
        }
        return true;
    }

    private get summaryPath(): string {
        return path.join(this.trackingDir!, CostTrackingLogger.SUMMARY_FILE);
    }

    private get logPath(): string {
        return path.join(this.trackingDir!, CostTrackingLogger.LOG_FILE);
    }

    private loadExistingTimestamps(): void {
        if (!this.trackingDir || !fs.existsSync(this.logPath)) {
            return;
        }
        try {
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const timestampRegex = /^ts=(\d+)/gm;
            let match;
            while ((match = timestampRegex.exec(content)) !== null) {
                this.loggedTimestamps.add(match[1]);
            }
        } catch {
            // If the log can't be read, start fresh tracking
        }
    }

    async logUsageEvents(events: UsageEvent[]): Promise<void> {
        if (events.length === 0) {
            return;
        }
        if (!this.ensureDirectory()) {
            return;
        }

        try {
            if (this.loggedTimestamps.size === 0) {
                this.loadExistingTimestamps();
            }
            this.updateSummaryFile(events);
            this.appendToRequestLog(events);
        } catch (error) {
            console.error('CostTrackingLogger: Failed to write tracking data', error);
        }
    }

    private updateSummaryFile(events: UsageEvent[]): void {
        this.lastKnownEvents = events;

        const summary: UsageSummary = {
            lastUpdated: new Date().toISOString(),
            summary: { totalRequests: 0, totalTokens: 0, totalCost: 0, totalCostDisplay: '$0.00' },
            byModel: {},
            byKind: {},
            recentEvents: [],
            activeSession: null
        };

        for (const event of events) {
            summary.summary.totalRequests++;
            summary.summary.totalTokens += event.tokens;
            summary.summary.totalCost += event.cost;

            const model = event.model || 'Unknown';
            if (!summary.byModel[model]) {
                summary.byModel[model] = { requests: 0, tokens: 0, cost: 0 };
            }
            summary.byModel[model].requests++;
            summary.byModel[model].tokens += event.tokens;
            summary.byModel[model].cost += event.cost;

            const kind = event.kind || 'Unknown';
            if (!summary.byKind[kind]) {
                summary.byKind[kind] = { requests: 0, tokens: 0, cost: 0 };
            }
            summary.byKind[kind].requests++;
            summary.byKind[kind].tokens += event.tokens;
            summary.byKind[kind].cost += event.cost;
        }

        summary.summary.totalCostDisplay = `$${summary.summary.totalCost.toFixed(4)}`;

        const sorted = [...events].sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
        summary.recentEvents = sorted.slice(0, 20);

        for (const entry of Object.values(summary.byModel)) {
            entry.cost = parseFloat(entry.cost.toFixed(6));
        }
        for (const entry of Object.values(summary.byKind)) {
            entry.cost = parseFloat(entry.cost.toFixed(6));
        }

        if (this.sessionStartMs) {
            const sessionEvents = events.filter(e => parseInt(e.timestamp) >= this.sessionStartMs!);
            summary.activeSession = this.buildSessionSummary(sessionEvents);
        }

        fs.writeFileSync(this.summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    }

    private appendToRequestLog(events: UsageEvent[]): void {
        const sorted = [...events].sort((a, b) => parseInt(a.timestamp) - parseInt(b.timestamp));
        const newLines: string[] = [];

        for (const event of sorted) {
            if (this.loggedTimestamps.has(event.timestamp)) {
                continue;
            }
            this.loggedTimestamps.add(event.timestamp);

            const isoTime = new Date(parseInt(event.timestamp)).toISOString();
            const line = `ts=${event.timestamp} [${isoTime}] Model: ${event.model} | Tokens: ${event.tokens.toLocaleString()} | Cost: ${event.costDisplay} | Kind: ${event.kind}`;
            newLines.push(line);
        }

        if (newLines.length > 0) {
            const payload = newLines.join('\n') + '\n';
            fs.appendFileSync(this.logPath, payload, 'utf-8');
        }
    }

    private loadSessionState(): void {
        if (!this.trackingDir) { return; }
        try {
            const summaryFile = path.join(this.trackingDir, CostTrackingLogger.SUMMARY_FILE);
            if (fs.existsSync(summaryFile)) {
                const data: UsageSummary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
                if (data.activeSession?.active) {
                    this.sessionStartMs = data.activeSession.startedAtMs;
                }
            }
        } catch {
            // corrupt file — ignore
        }
    }

    startSession(): string {
        this.sessionStartMs = Date.now();
        const iso = new Date(this.sessionStartMs).toISOString();

        if (this.ensureDirectory() && this.lastKnownEvents.length > 0) {
            this.updateSummaryFile(this.lastKnownEvents);
        }

        vscode.window.showInformationMessage(`Session started at ${iso}`);
        return iso;
    }

    stopSession(): string | null {
        if (!this.sessionStartMs) {
            vscode.window.showWarningMessage('No active session to stop.');
            return null;
        }
        if (!this.ensureDirectory()) {
            return null;
        }

        const sessionEvents = this.lastKnownEvents.filter(
            e => parseInt(e.timestamp) >= this.sessionStartMs!
        );

        const sessionSummary = this.buildSessionSummary(sessionEvents);
        sessionSummary.active = false;

        const startIso = new Date(this.sessionStartMs).toISOString();
        const safeName = startIso.replace(/:/g, '-').replace(/\./g, '-');
        const filename = `session-${safeName}.json`;
        const filePath = path.join(this.trackingDir!, filename);

        fs.writeFileSync(filePath, JSON.stringify(sessionSummary, null, 2), 'utf-8');

        this.sessionStartMs = null;

        if (this.lastKnownEvents.length > 0) {
            this.updateSummaryFile(this.lastKnownEvents);
        }

        vscode.window.showInformationMessage(`Session saved: ${filename}`);
        return filePath;
    }

    isSessionActive(): boolean {
        return this.sessionStartMs !== null;
    }

    private buildSessionSummary(events: UsageEvent[]): SessionSummary {
        const now = Date.now();
        const durationMs = now - this.sessionStartMs!;
        const minutes = Math.floor(durationMs / 60000);
        const hours = Math.floor(minutes / 60);
        const remainingMinutes = minutes % 60;
        const durationStr = hours > 0 ? `${hours}h ${remainingMinutes}m` : `${remainingMinutes}m`;

        const summary: SessionSummary = {
            active: true,
            startedAt: new Date(this.sessionStartMs!).toISOString(),
            startedAtMs: this.sessionStartMs!,
            duration: durationStr,
            summary: { totalRequests: 0, totalTokens: 0, totalCost: 0, totalCostDisplay: '$0.00' },
            byModel: {},
            events: []
        };

        for (const event of events) {
            summary.summary.totalRequests++;
            summary.summary.totalTokens += event.tokens;
            summary.summary.totalCost += event.cost;

            const model = event.model || 'Unknown';
            if (!summary.byModel[model]) {
                summary.byModel[model] = { requests: 0, tokens: 0, cost: 0 };
            }
            summary.byModel[model].requests++;
            summary.byModel[model].tokens += event.tokens;
            summary.byModel[model].cost += event.cost;
        }

        summary.summary.totalCostDisplay = `$${summary.summary.totalCost.toFixed(4)}`;

        for (const entry of Object.values(summary.byModel)) {
            entry.cost = parseFloat(entry.cost.toFixed(6));
        }

        summary.events = [...events].sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
        return summary;
    }

    getTrackingDir(): string | null {
        return this.trackingDir;
    }
}

class PriceItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly price: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        super(label, collapsibleState);
        this.description = this.price;
        this.tooltip = `${this.label} - ${this.price}`;
    }
}

class SessionCard extends vscode.TreeItem {
    constructor(
        public readonly usageEvent: UsageEvent,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None
    ) {
        const price = SessionCard.formatCost(usageEvent);
        super(price, collapsibleState);
        
        this.description = `${SessionCard.formatTokens(usageEvent.tokens)} • ${SessionCard.formatTime(usageEvent.timestamp)} • ${SessionCard.formatModelName(usageEvent.model)} • ${usageEvent.kind}`;
        this.tooltip = SessionCard.createTooltip(usageEvent);
        this.iconPath = SessionCard.getStatusIcon(usageEvent);
        this.contextValue = 'session-card';
    }

    private static formatModelName(model: string): string {
        const lowerModel = model.toLowerCase();
        
        // Auto model
        if (lowerModel === 'auto') return '🎯 Auto';
        
        // Claude models
        if (lowerModel.includes('claude')) {
            if (lowerModel.includes('4') && lowerModel.includes('sonnet')) return '🧠 Claude 4 Sonnet';
            if (lowerModel.includes('3.5') && lowerModel.includes('sonnet')) return '🧠 Claude 3.5 Sonnet';
            if (lowerModel.includes('3') && lowerModel.includes('haiku')) return '🧠 Claude 3 Haiku';
            if (lowerModel.includes('3') && lowerModel.includes('opus')) return '🧠 Claude 3 Opus';
            return '🧠 ' + model.charAt(0).toUpperCase() + model.slice(1);
        }
        
        // GPT models
        if (lowerModel.includes('gpt')) {
            if (lowerModel.includes('4o')) return '🤖 GPT-4o';
            if (lowerModel.includes('4') && lowerModel.includes('turbo')) return '🤖 GPT-4 Turbo';
            if (lowerModel.includes('4')) return '🤖 GPT-4';
            if (lowerModel.includes('3.5')) return '🤖 GPT-3.5';
            return '🤖 ' + model.toUpperCase();
        }
        
        // Other models
        if (lowerModel.includes('gemini')) return '💎 ' + model.charAt(0).toUpperCase() + model.slice(1);
        if (lowerModel.includes('llama') && lowerModel.includes('code')) return '🦙 Code Llama';
        if (lowerModel.includes('llama')) return '🦙 ' + model.charAt(0).toUpperCase() + model.slice(1);
        if (lowerModel.includes('mistral')) return '🌬️ ' + model.charAt(0).toUpperCase() + model.slice(1);
        if (lowerModel.includes('palm')) return '🌴 ' + model.charAt(0).toUpperCase() + model.slice(1);
        if (lowerModel.includes('bard')) return '🎭 ' + model.charAt(0).toUpperCase() + model.slice(1);
        if (lowerModel.includes('codex')) return '💻 ' + model.charAt(0).toUpperCase() + model.slice(1);
        
        // Default: capitalize first letter
        return model.charAt(0).toUpperCase() + model.slice(1);
    }

    private static formatTime(timestamp: string): string {
        return new Date(parseInt(timestamp)).toLocaleTimeString('en-US', {
            hour12: true,
            hour: 'numeric',
            minute: '2-digit'
        });
    }

    private static formatCost(event: UsageEvent): string {
        if (typeof event.cost === 'number' && event.cost > 0) {
            if (event.cost < 0.2) {
                return `✅ ${event.costDisplay}`;
            } else if (event.cost <= 0.5) {
                return `⚠️ ${event.costDisplay}`;
            } else {
                return `🚨 ${event.costDisplay}`;
            }
        } else if (event.kind.includes('INCLUDED')) {
            return '💎 Included';
        } else if (event.kind.includes('ERRORED_NOT_CHARGED')) {
            return '❌ Error - Not Charged';
        } else if (typeof event.cost === 'number' && event.cost == 0) {
            return '🆓 Free';
        }
        else {
            return 'Unknown';
        }
    }

    private static formatTokens(tokens: number): string {
        return tokens.toLocaleString() + " tokens";
    }

    private static createTooltip(event: UsageEvent): string {
        const isPro = event.kind.includes('INCLUDED_IN_PRO');
        const costText = isPro ? 'Included in Pro Plan' : `$${event.cost.toFixed(4)}`;
        
        // Cost status
        let costStatus = '';
        if (typeof event.cost === 'number' && event.cost > 0) {
            if (event.cost < 0.2) {
                costStatus = `✅ Low Cost: $${event.cost.toFixed(3)}`;
            } else if (event.cost <= 0.5) {
                costStatus = `⚠️ Medium Cost: $${event.cost.toFixed(3)}`;
            } else {
                costStatus = `🚨 High Cost: $${event.cost.toFixed(3)}`;
            }
        } else if (event.kind.includes('INCLUDED')) {
            costStatus = '💎 Included in Plan';
        } else if (event.kind.includes('ERRORED_NOT_CHARGED')) {
            costStatus = '❌ Error - Not Charged';
        } else if (typeof event.cost === 'number' && event.cost === 0) {
            costStatus = '🆓 Free';
        } else {
            costStatus = '❓ Unknown Cost';
        }
        
        return [
            costStatus,
            `🕐 Time: ${SessionCard.formatTime(event.timestamp)}`,
            `🔢 Tokens: ${SessionCard.formatTokens(event.tokens)}`,
            `🤖 Model: ${event.model}`,
            `📊 Type: ${event.kind}`
        ].join('\n');
    }

    private static getStatusIcon(event: UsageEvent): vscode.ThemeIcon {
        const isPro = event.kind.includes('INCLUDED_IN_PRO');
        const hasHighCost = event.cost > 0.1;
        
        if (isPro) return new vscode.ThemeIcon('star-full');
        if (hasHighCost) return new vscode.ThemeIcon('warning');
        return new vscode.ThemeIcon('pass');
    }
}

class ApiService {
    private static readonly API_URL = 'https://cursor.com/api/dashboard/get-filtered-usage-events';
    
    static async fetchUsageData(sessionToken: string, timeRange: 'last30m' | 'last24h' = 'last24h'): Promise<UsageEvent[]> {
        const now = Date.now();
        const timeOffset = timeRange === 'last30m' ? (30 * 60 * 1000) : (24 * 60 * 60 * 1000);
        const startTime = now - timeOffset;
        
        const requestData = {
            teamId: 0,
            startDate: startTime.toString(),
            endDate: now.toString(),
            page: 1,
            pageSize: 100
        };


        return new Promise((resolve, reject) => {
            const options = {
                method: 'POST',
                headers: {
                    'accept': '*/*',
                    'content-type': 'application/json',
                    'origin': 'https://cursor.com',
                    'referer': 'https://cursor.com/dashboard?tab=usage',
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
                    'Cookie': sessionToken
                }
            };

            const req = https.request(this.API_URL, options, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        
                        if (response.usageEventsDisplay) {
                            const usageEvents: UsageEvent[] = response.usageEventsDisplay.map((event: any) => {
                                const eventDate = new Date(parseInt(event.timestamp));
                                const costInfo = this.parseCostFromUsageBasedCosts(event.usageBasedCosts);
                                return {
                                    timestamp: event.timestamp,
                                    date: eventDate.toLocaleDateString(),
                                    time: eventDate.toLocaleTimeString(),
                                    model: event.model || 'Unknown',
                                    tokens: (event.tokenUsage?.cacheWriteTokens || 0) + (event.tokenUsage?.cacheReadTokens || 0) + (event.tokenUsage?.inputTokens || 0) + (event.tokenUsage?.outputTokens || 0),
                                    cost: costInfo.numericValue,
                                    costDisplay: costInfo.displayValue,
                                    kind: event.kind || 'Unknown'
                                };
                            });
                            resolve(usageEvents);
                        } else {
                            resolve([]);
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', reject);
            
            req.write(JSON.stringify(requestData));
            req.end();
        });
    }

    private static parseCostFromUsageBasedCosts(usageBasedCosts: any): { numericValue: number, displayValue: string } {
        if (!usageBasedCosts) {
            return { numericValue: 0, displayValue: '$0.00' };
        }

        // If usageBasedCosts is a string like "$0.05"
        if (typeof usageBasedCosts === 'string') {
            const cleanCost = usageBasedCosts.replace(/[$,]/g, '');
            const parsedCost = parseFloat(cleanCost);
            return {
                numericValue: isNaN(parsedCost) ? 0 : parsedCost,
                displayValue: usageBasedCosts // Keep original format
            };
        }

        // If usageBasedCosts is a number
        if (typeof usageBasedCosts === 'number') {
            return {
                numericValue: usageBasedCosts,
                displayValue: `$${usageBasedCosts.toFixed(2)}`
            };
        }

        // If usageBasedCosts is an object, try to find cost value
        if (typeof usageBasedCosts === 'object') {
            // Check for common cost field names
            const possibleFields = ['cost', 'totalCost', 'amount', 'price', 'value'];
            for (const field of possibleFields) {
                if (usageBasedCosts[field] !== undefined) {
                    const fieldValue = usageBasedCosts[field];
                    if (typeof fieldValue === 'string') {
                        const cleanCost = fieldValue.replace(/[$,]/g, '');
                        const parsedCost = parseFloat(cleanCost);
                        return {
                            numericValue: isNaN(parsedCost) ? 0 : parsedCost,
                            displayValue: fieldValue // Keep original format
                        };
                    } else if (typeof fieldValue === 'number') {
                        return {
                            numericValue: fieldValue,
                            displayValue: `$${fieldValue.toFixed(2)}`
                        };
                    }
                }
            }

            // If it's an array, sum all values and create display
            if (Array.isArray(usageBasedCosts)) {
                const results = usageBasedCosts.map(item => this.parseCostFromUsageBasedCosts(item));
                const totalNumeric = results.reduce((total, result) => total + result.numericValue, 0);
                const displayValues = results.map(result => result.displayValue).filter(val => val !== '$0.00');
                return {
                    numericValue: totalNumeric,
                    displayValue: displayValues.length > 0 ? displayValues.join(' + ') : `$${totalNumeric.toFixed(2)}`
                };
            }
        }

        return { numericValue: 0, displayValue: '$0.00' };
    }
}

class PriceDataProvider implements vscode.TreeDataProvider<PriceItem | SessionCard> {
    private _onDidChangeTreeData: vscode.EventEmitter<PriceItem | SessionCard | undefined | null | void> = new vscode.EventEmitter<PriceItem | SessionCard | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<PriceItem | SessionCard | undefined | null | void> = this._onDidChangeTreeData.event;
    private usageData: UsageEvent[] = [];
    private sessionToken: string = '';
    private statusBarManager: StatusBarManager | undefined;
    private costTrackingLogger: CostTrackingLogger;

    constructor() {
        this.costTrackingLogger = new CostTrackingLogger();
        this.loadSessionToken();
    }

    setStatusBarManager(statusBarManager: StatusBarManager): void {
        this.statusBarManager = statusBarManager;
    }

    getCostTrackingLogger(): CostTrackingLogger {
        return this.costTrackingLogger;
    }

    private async loadSessionToken(): Promise<void> {
        const config = vscode.workspace.getConfiguration('cursorPriceTracking');
        this.sessionToken = config.get('sessionToken', '');
        
        if (!this.sessionToken) {
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your Cursor session token',
                password: true,
                placeHolder: 'WorkosCursorSessionToken value from browser cookies'
            });
            
            if (token) {
                this.sessionToken = token;
                await config.update('sessionToken', token, vscode.ConfigurationTarget.Global);
            }
        }
    }

    getTreeItem(element: PriceItem | SessionCard): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PriceItem | SessionCard): Promise<(PriceItem | SessionCard)[]> {
        if (!element) {
            if (!this.sessionToken) {
                // Update status bar to show no token state
                if (this.statusBarManager) {
                    this.statusBarManager.showNoToken();
                }
                return [new PriceItem('No session token', 'Configure in settings')];
            }

            try {
                this.usageData = await ApiService.fetchUsageData(this.sessionToken, 'last24h');
                
                // Log usage data to workspace tracking directory
                await this.costTrackingLogger.logUsageEvents(this.usageData);

                // Update status bar with the first item data
                if (this.statusBarManager) {
                    if (this.usageData.length > 0) {
                        const sortedData = this.usageData.sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
                        const firstItem = sortedData[0];
                        this.statusBarManager.updateUsageEvent(firstItem);
                    } else {
                        this.statusBarManager.updateUsageEvent(null);
                    }
                }
                
                if (this.usageData.length === 0) {
                    return [new PriceItem('No usage data', 'Last 24 hours')];
                }

                // Create iOS-style cards for recent sessions
                const headerItem = new PriceItem(
                    '📱 Recent Sessions',
                    'Last 24 hours'
                );
                headerItem.iconPath = new vscode.ThemeIcon('history');
                
                const sessionCards = this.usageData
                    .sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp))
                    .map(event => new SessionCard(event));
                
                return [headerItem, ...sessionCards];
            } catch (error) {
                console.error('Failed to fetch usage data:', error);
                // Update status bar to show error state
                if (this.statusBarManager) {
                    this.statusBarManager.showError();
                }
                return [new PriceItem('Error fetching data', 'Check token/connection')];
            }
        }
        return [];
    }

    async refresh(): Promise<void> {
        await this.loadSessionToken();
        
        // Directly fetch data and update status bar to ensure it's not stuck on loading
        if (this.statusBarManager) {
            if (!this.sessionToken) {
                this.statusBarManager.showNoToken();
            } else {
                try {
                    const usageData = await ApiService.fetchUsageData(this.sessionToken, 'last24h');
                    await this.costTrackingLogger.logUsageEvents(usageData);
                    if (usageData.length > 0) {
                        const sortedData = usageData.sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
                        const firstItem = sortedData[0];
                        this.statusBarManager.updateUsageEvent(firstItem);
                    } else {
                        this.statusBarManager.updateUsageEvent(null);
                    }
                } catch (error) {
                    console.error('Failed to refresh status bar:', error);
                    this.statusBarManager.showError();
                }
            }
        }
        
        this._onDidChangeTreeData.fire();
    }

    async setToken(): Promise<void> {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Cursor session token',
            password: true,
            placeHolder: 'WorkosCursorSessionToken value from browser cookies'
        });
        
        if (token) {
            const formattedToken = `WorkosCursorSessionToken=${token}`;
            this.sessionToken = formattedToken;
            const config = vscode.workspace.getConfiguration('cursorPriceTracking');
            await config.update('sessionToken', formattedToken, vscode.ConfigurationTarget.Global);
            this._onDidChangeTreeData.fire();
        }
    }

    async clearToken(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            'Are you sure you want to clear the stored token?',
            'Yes',
            'No'
        );
        
        if (confirm === 'Yes') {
            this.sessionToken = '';
            const config = vscode.workspace.getConfiguration('cursorPriceTracking');
            await config.update('sessionToken', '', vscode.ConfigurationTarget.Global);
            this._onDidChangeTreeData.fire();
        }
    }

}

class StatusBarManager {
    private statusBarItem: vscode.StatusBarItem;
    private isLoading: boolean = false;
    private currentUsageEvent: UsageEvent | null = null;
    private sessionToken: string = '';

    constructor(context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'cursorPriceTracking.refresh';
        this.statusBarItem.tooltip = "Click to refresh Cursor usage data";
        this.statusBarItem.show();
        
        // Start with loading state instead of $0.00
        this.isLoading = true;
        this.updateDisplay();
        
        context.subscriptions.push(this.statusBarItem);
    }

    async loadSessionToken(): Promise<void> {
        const config = vscode.workspace.getConfiguration('cursorPriceTracking');
        this.sessionToken = config.get('sessionToken', '');
    }

    private updateDisplay(): void {
        if (this.isLoading) {
            this.statusBarItem.text = "$(loading~spin) Cursor: Loading...";
            this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.remoteBackground');
            this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
        } else if (this.currentUsageEvent) {
            // Use the same format as SessionCard with token count and emoji
            const emoji = this.getCostEmoji(this.currentUsageEvent);
            const cost = this.formatCost(this.currentUsageEvent);
            const tokenCount = this.formatTokenCount(this.currentUsageEvent.tokens);
            this.statusBarItem.text = `${emoji} Usage: ${cost} | ${tokenCount}`;
            
            // Set theme colors based on cost level
            if (typeof this.currentUsageEvent.cost === 'number' && this.currentUsageEvent.cost > 0.5) {
                // High cost - red theme
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else if (typeof this.currentUsageEvent.cost === 'number' && this.currentUsageEvent.cost >= 0.2) {
                // Medium cost - yellow theme
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else if (typeof this.currentUsageEvent.cost === 'number' && this.currentUsageEvent.cost > 0) {
                // Low cost - green theme
                this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.remoteBackground');
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
            } else {
                // Default for other cases
                this.statusBarItem.color = undefined;
                this.statusBarItem.backgroundColor = undefined;
            }
        } else {
            this.statusBarItem.text = "Usage: No activity";
            this.statusBarItem.backgroundColor = undefined;
        }
    }

    private getCostEmoji(event: UsageEvent): string {
        if (typeof event.cost === 'number' && event.cost > 0) {
            if (event.cost < 0.2) {
                return '✅';
            } else if (event.cost <= 0.5) {
                return '⚠️';
            } else {
                return '🚨';
            }
        } else if (event.kind.includes('INCLUDED')) {
            return '💎';
        } else if (event.kind.includes('ERRORED_NOT_CHARGED')) {
            return '❌';
        } else if (typeof event.cost === 'number' && event.cost === 0) {
            return '🆓';
        } else {
            return '❓';
        }
    }

    private formatCostWithEmoji(event: UsageEvent): string {
        if (typeof event.cost === 'number' && event.cost > 0) {
            if (event.cost < 0.2) {
                return `✅ ${event.costDisplay}`;
            } else if (event.cost <= 0.5) {
                return `⚠️ ${event.costDisplay}`;
            } else {
                return `🚨 ${event.costDisplay}`;
            }
        } else if (event.kind.includes('INCLUDED')) {
            return '💎 Included';
        } else if (event.kind.includes('ERRORED_NOT_CHARGED')) {
            return '❌ Error';
        } else if (typeof event.cost === 'number' && event.cost === 0) {
            return '🆓 Free';
        } else {
            return 'Unknown';
        }
    }

    private formatTokenCount(tokens: number): string {
        if (tokens >= 1000000) {
            return `${(tokens / 1000000).toFixed(1)}M`;
        } else if (tokens >= 1000) {
            return `${Math.round(tokens / 1000)}k`;
        } else {
            return tokens.toString();
        }
    }

    private formatCost(event: UsageEvent): string {
        if (typeof event.cost === 'number' && event.cost > 0) {
            return event.costDisplay;
        } else if (event.kind.includes('INCLUDED')) {
            return 'Included';
        } else if (event.kind.includes('ERRORED_NOT_CHARGED')) {
            return 'Error';
        } else if (typeof event.cost === 'number' && event.cost === 0) {
            return 'Free';
        } else {
            return 'Unknown';
        }
    }

    async refreshData(): Promise<void> {
        if (this.isLoading) return;

        this.isLoading = true;
        this.updateDisplay();

        try {
            await this.loadSessionToken();
            
            if (!this.sessionToken) {
                vscode.window.showWarningMessage('No Cursor session token configured. Use "Set Token" command first.');
                this.isLoading = false;
                this.updateDisplay();
                return;
            }

            const usageData = await ApiService.fetchUsageData(this.sessionToken, 'last30m');
            if (usageData.length > 0) {
                const sortedData = usageData.sort((a, b) => parseInt(b.timestamp) - parseInt(a.timestamp));
                this.currentUsageEvent = sortedData[0];
            } else {
                this.currentUsageEvent = null;
            }
        } catch (error) {
            console.error('Failed to refresh status bar data:', error);
        } finally {
            this.isLoading = false;
            this.updateDisplay();
        }
    }

    updateUsageEvent(event: UsageEvent | null): void {
        this.isLoading = false; // Reset loading state
        this.currentUsageEvent = event;
        this.updateDisplay();
    }

    updateCost(cost: number): void {
        this.isLoading = false; // Reset loading state
        // Create a simple usage event for backward compatibility
        if (cost > 0) {
            this.currentUsageEvent = {
                timestamp: Date.now().toString(),
                date: new Date().toLocaleDateString(),
                time: new Date().toLocaleTimeString(),
                model: 'Unknown',
                tokens: 0,
                cost: cost,
                costDisplay: `$${cost.toFixed(2)}`,
                kind: 'USAGE'
            };
        } else {
            this.currentUsageEvent = null;
        }
        this.updateDisplay();
    }

    showError(): void {
        this.isLoading = false;
        this.statusBarItem.text = "Cursor: Error";
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        this.statusBarItem.tooltip = "Failed to load Cursor pricing data. Click to retry or configure token.";
    }

    showNoToken(): void {
        this.isLoading = false;
        this.statusBarItem.text = "Cursor: No Token";
        this.statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        this.statusBarItem.tooltip = "No session token configured. Click to configure token.";
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "cursor-price-tracking" is now active!');

    // Create status bar manager
    const statusBarManager = new StatusBarManager(context);

    // Create tree data provider
    const priceDataProvider = new PriceDataProvider();
    const treeView = vscode.window.createTreeView('cursorPrices', {
        treeDataProvider: priceDataProvider
    });

    // Connect status bar manager to price data provider
    priceDataProvider.setStatusBarManager(statusBarManager);

    // Register commands

    const refreshCommand = vscode.commands.registerCommand('cursorPriceTracking.refresh', async () => {
        await priceDataProvider.refresh();
    });


    const configureCommand = vscode.commands.registerCommand('cursorPriceTracking.configure', async () => {
        await priceDataProvider.setToken();
        statusBarManager.refreshData();
    });

    const resetCommand = vscode.commands.registerCommand('cursorPriceTracking.reset', async () => {
        await priceDataProvider.clearToken();
        statusBarManager.updateCost(0);
    });

    const openTrackingCommand = vscode.commands.registerCommand('cursorPriceTracking.openTracking', async () => {
        const logger = priceDataProvider.getCostTrackingLogger();
        const dir = logger.getTrackingDir();
        if (dir && fs.existsSync(dir)) {
            const summaryFile = path.join(dir, 'usage-summary.json');
            if (fs.existsSync(summaryFile)) {
                const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(summaryFile));
                await vscode.window.showTextDocument(doc);
            } else {
                vscode.window.showInformationMessage('No tracking data yet. Refresh usage data first.');
            }
        } else {
            vscode.window.showInformationMessage('No workspace open or tracking directory not created yet.');
        }
    });

    const startSessionCommand = vscode.commands.registerCommand('cursorPriceTracking.startSession', async () => {
        const logger = priceDataProvider.getCostTrackingLogger();
        if (logger.isSessionActive()) {
            const answer = await vscode.window.showWarningMessage(
                'A session is already active. Stop it and start a new one?',
                'Yes', 'No'
            );
            if (answer !== 'Yes') { return; }
            logger.stopSession();
        }
        logger.startSession();
        await priceDataProvider.refresh();
    });

    const stopSessionCommand = vscode.commands.registerCommand('cursorPriceTracking.stopSession', async () => {
        const logger = priceDataProvider.getCostTrackingLogger();
        if (!logger.isSessionActive()) {
            vscode.window.showWarningMessage('No active session to stop.');
            return;
        }
        await priceDataProvider.refresh();
        const filePath = logger.stopSession();
        if (filePath) {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
            await vscode.window.showTextDocument(doc);
        }
    });

    const initTrackingCommand = vscode.commands.registerCommand('cursorPriceTracking.initTracking', async () => {
        const logger = priceDataProvider.getCostTrackingLogger();
        const dir = logger.getTrackingDir();
        if (!dir) {
            vscode.window.showWarningMessage('No workspace folder open. Open a folder first.');
            return;
        }
        if (fs.existsSync(dir)) {
            vscode.window.showInformationMessage(`Tracking directory already exists at ${dir}`);
        } else {
            fs.mkdirSync(dir, { recursive: true });
            vscode.window.showInformationMessage(`Created tracking directory: .cursor-cost-tracking/`);
        }
    });

    context.subscriptions.push(refreshCommand);
    context.subscriptions.push(configureCommand);
    context.subscriptions.push(resetCommand);
    context.subscriptions.push(openTrackingCommand);
    context.subscriptions.push(startSessionCommand);
    context.subscriptions.push(stopSessionCommand);
    context.subscriptions.push(initTrackingCommand);
    context.subscriptions.push(treeView);

    // Auto-fetch data when VSCode opens - start immediately
    priceDataProvider.refresh().catch(() => {
        // If initial load fails, show error state in status bar
        statusBarManager.showError();
    });
}

export function deactivate() {}