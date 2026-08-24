/**
 * Bootstrap: importing this module registers every connector. Anything that
 * needs the registry populated — the integrations panel, the step-4 agent —
 * imports this rather than reaching into individual connector files, so a new
 * tool only needs registering once, here.
 */

import './enrich/fx'
import './enrich/calendar'
import './enrich/ifsc'
import './actions/slack'
import './actions/razorpay'

export { registerTool, getTool, listTools, toolStatusReport } from './registry'
export type { ToolSpec, ToolResult, ToolMode, ToolStatusReport } from './registry'
