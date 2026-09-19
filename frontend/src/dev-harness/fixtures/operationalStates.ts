export const operationalFixtures=[
 {id:'provider-cooldown',title:'Provider cooldown',detail:'Contract fixture only: cooldown detail is currently partial.',tone:'warning' as const},
 {id:'code-lane-full',title:'Code lane full',detail:'Two Code tasks are already running.',tone:'warning' as const},
 {id:'mcp-disconnected',title:'MCP disconnected',detail:'A configured MCP server is not connected.',tone:'error' as const},
 {id:'backup-diff',title:'Backup diff ready',detail:'Review changes before restoring the backup.',tone:'info' as const},
 {id:'interrupted-gap',title:'Interrupted task unavailable',detail:'The current backend TaskRun contract does not expose interrupted.',tone:'neutral' as const},
];
