import type { FunctionDeclaration } from '@google/genai';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './fs.js';
import { viewMediaTool } from './media.js';
import { globTool, grepTool } from './search.js';
import { runCommandTool } from './shell.js';
import type { ToolDef } from './types.js';
import { webFetchTool } from './web.js';

/** 常に有効な組み込みツール */
export const TOOLS: ToolDef[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  viewMediaTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  webFetchTool,
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

export function toolDeclarations(): FunctionDeclaration[] {
  return TOOLS.map((t) => t.declaration);
}

export * from './types.js';
