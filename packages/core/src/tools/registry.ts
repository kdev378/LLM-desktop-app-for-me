import {
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
} from './files.js';
import { runCommandTool } from './command.js';
import type { ToolDefinition } from '../provider/types.js';
import type { ToolSpec } from './types.js';

/** 標準のツール。仕様: docs/spec/05-agent.md「ツール一覧」 */
export const BUILTIN_TOOLS: ToolSpec[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  runCommandTool,
];

export const READ_ONLY_TOOL_NAMES = [readFileTool, listDirTool, globTool, grepTool].map(
  (t) => t.name,
);
export const ALL_TOOL_NAMES = BUILTIN_TOOLS.map((t) => t.name);

/**
 * 使うツールを選ぶ。未知の名前は無視せずに知らせる
 * （黙って減らすと、なぜ動かないのか分からなくなる）。
 */
export function selectTools(names?: string[]): { tools: ToolSpec[]; unknown: string[] } {
  if (!names) return { tools: [...BUILTIN_TOOLS], unknown: [] };
  const byName = new Map(BUILTIN_TOOLS.map((t) => [t.name, t]));
  const tools: ToolSpec[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const t = byName.get(n);
    if (t) tools.push(t);
    else unknown.push(n);
  }
  return { tools, unknown };
}

export function toolDefinitions(tools: ToolSpec[]): ToolDefinition[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export function findTool(tools: ToolSpec[], name: string): ToolSpec | undefined {
  return tools.find((t) => t.name === name);
}
