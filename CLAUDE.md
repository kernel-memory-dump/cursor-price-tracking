git add -# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VSCode extension called "Cursor Price Tracking" that monitors Cursor AI usage and costs. The extension fetches real-time usage data from Cursor's API and displays it through a tree view panel and status bar integration.

## Development Commands

### Build and Compilation
- `npm run compile` - Compile TypeScript source files to JavaScript in the `out/` directory
- `npm run watch` - Watch for changes and automatically recompile TypeScript files
- `npm run vscode:prepublish` - Prepare extension for publishing (runs compile)

### Testing and Development
- Press `F5` in VSCode to launch Extension Development Host with the extension loaded
- Use Command Palette (`Ctrl+Shift+P`) to test commands
- Extension auto-activates on VSCode startup (`onStartupFinished`)

## Architecture

### Core Components

**Main Classes:**
- `PriceDataProvider` - Tree data provider implementing `vscode.TreeDataProvider` for the pricing panel
- `StatusBarManager` - Manages status bar display with cost information and loading states
- `ApiService` - Handles HTTP requests to Cursor's usage API with session token authentication
- `SessionCard` - Tree item representing individual usage events with rich formatting
- `PriceItem` - Basic tree item for static content and error states

### Data Model

**UsageEvent Interface:**
```typescript
interface UsageEvent {
    timestamp: string;     // Unix timestamp
    date: string;         // Formatted date
    time: string;         // Formatted time
    model: string;        // AI model used (Claude, GPT, etc.)
    tokens: number;       // Total token count
    cost: number;         // Numeric cost value
    costDisplay: string;  // Formatted cost string from API
    kind: string;         // Usage type (INCLUDED_IN_PRO, USAGE, etc.)
}
```

### API Integration

The extension authenticates with Cursor's API using the `WorkosCursorSessionToken` cookie:
- **Endpoint**: `https://cursor.com/api/dashboard/get-filtered-usage-events`
- **Authentication**: Session token passed as Cookie header
- **Data Range**: Configurable (last30m, last24h)
- **Error Handling**: Comprehensive error states with user feedback

### VSCode Extension Integration

**Commands (all registered in package.json):**
- `cursorPriceTracking.refresh` - Refresh panel data
- `cursorPriceTracking.configure` - Configure session token
- `cursorPriceTracking.reset` - Remove stored token
- `cursorPriceTracking.openTracking` - Open the `.cursor-cost-tracking` usage summary

**UI Components:**
- Tree view in custom panel container (`cursorPricePanel`)
- Status bar item with click-to-refresh functionality
- Rich tooltips with cost categorization and emoji indicators

### State Management

**Configuration:**
- Session token stored in VSCode workspace configuration
- Automatic token prompting on first use
- Global configuration target for persistence

**Status Bar States:**
- Loading (with spinner)
- Active usage (with cost-based color theming)
- Error states (connection/token issues)
- No token configured

### Cost Display Logic

**Cost Categorization:**
- ✅ Low cost: < $0.20 (green theme)
- ⚠️ Medium cost: $0.20-$0.50 (yellow theme)  
- 🚨 High cost: > $0.50 (red theme)
- 💎 Included in Pro plan
- 🆓 Free usage
- ❌ Error/not charged

### Model Recognition

The extension recognizes and formats various AI models:
- Claude models (3 Haiku, 3.5 Sonnet, 4 Sonnet, Opus)
- GPT models (3.5, 4, 4o, 4 Turbo)
- Other models (Gemini, Llama, Mistral, etc.)

## Development Notes

### TypeScript Configuration
- Target: ES2020 with CommonJS modules
- Strict mode enabled for type safety
- Source maps generated for debugging
- Root directory: `src/`, output directory: `out/`

### Extension Lifecycle
- Auto-activation on VSCode startup
- Immediate data fetch on activation
- Proper cleanup with context subscriptions
- Error recovery with status bar feedback

### Workspace Cost Tracking (`.cursor-cost-tracking/`)

The extension creates a `.cursor-cost-tracking` directory in the workspace root to persist usage data locally.

**CostTrackingLogger** manages two files:

- **`usage-summary.json`** — A JSON snapshot updated on every refresh containing:
  - `summary`: aggregate totals (requests, tokens, cost)
  - `byModel`: breakdown per AI model
  - `byKind`: breakdown per usage kind (INCLUDED_IN_PRO, USAGE, etc.)
  - `recentEvents`: last 20 usage events
  - `lastUpdated`: ISO timestamp of last write

- **`requests.log`** — An append-only text log with one line per usage event:
  ```
  ts=<unix_ms> [<ISO timestamp>] Model: <model> | Tokens: <count> | Cost: <display> | Kind: <type>
  ```

**Deduplication**: The logger tracks already-logged event timestamps in memory (seeded from parsing the existing log file on first run) to avoid duplicate log entries across refreshes.

**Workspace requirement**: Tracking only activates when a workspace folder is open. If no workspace is open, the logger silently no-ops.

### API Data Processing
- Complex cost parsing from various API response formats
- Token aggregation from multiple sources (cache, input, output tokens)
- Timestamp formatting and sorting
- Robust error handling for API changes