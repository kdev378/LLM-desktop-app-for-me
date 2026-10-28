import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Static,
  Text,
  useApp,
  useBoxMetrics,
  useCursor,
  useInput,
  usePaste,
  useWindowSize,
  type DOMElement,
} from 'ink';
import type { PermissionMode } from '@akari/core';
import type { Controller, Dialog, Item, Line, Snapshot } from './controller.js';
import {
  InputHistory,
  backslashNewline,
  backspace,
  del,
  down,
  emptyEditor,
  insert,
  killToLineStart,
  layout,
  left,
  lineEnd,
  lineStart,
  right,
  up,
  type EditorState,
} from './editor.js';
import { accentColor, styleOf } from './theme.js';

/**
 * 対話画面の見た目。仕様: docs/spec/17-interactive.md「画面」「操作」
 * 状態はすべて Controller が持つ。ここはそれを写し、キーを Controller へ渡すだけ。
 */

const PROMPT = '› ';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const COMMANDS = [
  '/help',
  '/new',
  '/model',
  '/permission',
  '/tools',
  '/context',
  '/digest',
  '/diff',
  '/undo',
  '/exit',
];

export function App({ controller }: { controller: Controller }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [editor, setEditor] = useState<EditorState>(emptyEditor);
  const history = useRef(new InputHistory());

  // 閉じる前に入力欄と状態の行を消す。残すと、閉じた後に出す案内がその上に重なる
  const [closing, setClosing] = useState(false);
  useEffect(() => controller.setExitHandler(() => setClosing(true)), [controller]);
  useEffect(() => {
    if (closing) exit();
  }, [closing, exit]);

  const acceptsText = snap.dialog === null && (snap.busy === null || snap.inputHint !== null);

  usePaste((text) => {
    if (acceptsText) setEditor((e) => insert(e, text));
  });

  useInput((input, key) => {
    // どの状態でも効くもの
    if (key.ctrl && input === 'c') {
      if (editor.text !== '' && !controller.isBusy && !snap.dialog) {
        setEditor(emptyEditor);
        return;
      }
      controller.interrupt();
      return;
    }
    if (key.escape) {
      controller.escape();
      return;
    }

    // 選択肢の表示中
    if (snap.dialog) {
      if (key.upArrow) controller.moveSelection(-1);
      else if (key.downArrow) controller.moveSelection(1);
      else if (key.return) controller.chooseSelected();
      else if (input.length === 1) controller.pickByKey(input.toLowerCase());
      return;
    }

    if (key.tab && key.shift) {
      controller.cyclePermission();
      return;
    }
    if (!acceptsText) return;

    // 改行: Shift+Enter（区別できる端末）/ Option+Enter / Ctrl+J / 「\」+ Enter
    if ((key.return && (key.shift || key.meta)) || input === '\n') {
      setEditor((e) => insert(e, '\n'));
      return;
    }
    if (key.return) {
      const escaped = backslashNewline(editor);
      if (escaped) {
        setEditor(escaped);
        return;
      }
      const text = editor.text;
      if (text.trim() === '' && snap.inputHint === null) return;
      if (snap.inputHint === null) history.current.push(text);
      setEditor(emptyEditor);
      void controller.submit(text);
      return;
    }
    if (key.tab) {
      setEditor((e) => complete(e));
      return;
    }
    if (key.upArrow) {
      const moved = up(editor);
      if (moved) setEditor(moved);
      else {
        const prev = history.current.prev(editor.text);
        if (prev !== null) setEditor({ text: prev, cursor: prev.length });
      }
      return;
    }
    if (key.downArrow) {
      const moved = down(editor);
      if (moved) setEditor(moved);
      else {
        const next = history.current.next();
        if (next !== null) setEditor({ text: next, cursor: next.length });
      }
      return;
    }
    if (key.leftArrow) return setEditor((e) => left(e));
    if (key.rightArrow) return setEditor((e) => right(e));
    if (key.home || (key.ctrl && input === 'a')) return setEditor((e) => lineStart(e));
    if (key.end || (key.ctrl && input === 'e')) return setEditor((e) => lineEnd(e));
    if (key.ctrl && input === 'u') return setEditor((e) => killToLineStart(e));
    if (key.ctrl && input === 'd') {
      if (editor.text === '') controller.exit();
      else setEditor((e) => del(e));
      return;
    }
    if (key.backspace) return setEditor((e) => backspace(e));
    if (key.delete) return setEditor((e) => del(e));
    if (key.ctrl || key.meta) return;
    if (input !== '') {
      history.current.reset();
      setEditor((e) => insert(e, input));
    }
  });

  return (
    <>
      <Static items={snap.items}>{(item) => <ItemView key={item.id} item={item} />}</Static>
      {closing ? null : (
        <Live snap={snap} columns={columns} editor={editor} acceptsText={acceptsText} />
      )}
    </>
  );
}

/** Tab で / コマンドを補完する。候補が1つに絞れたときだけ。 */
function complete(e: EditorState): EditorState {
  if (!e.text.startsWith('/') || e.text.includes(' ') || e.text.includes('\n')) return e;
  const hits = COMMANDS.filter((c) => c.startsWith(e.text));
  if (hits.length !== 1) return e;
  const text = `${hits[0]!} `;
  return { text, cursor: text.length };
}

function Live({
  snap,
  columns,
  editor,
  acceptsText,
}: {
  snap: Snapshot;
  columns: number;
  editor: EditorState;
  acceptsText: boolean;
}) {
  const inputRef = useRef<DOMElement>(null);
  const metrics = useBoxMetrics(inputRef);
  const { setCursorPosition } = useCursor();
  // 枠（1）+ 余白（1）+ 記号（2）
  const textWidth = Math.max(10, columns - 6);
  const view = layout(editor, textWidth);

  // 日本語の変換中の文字をカーソル位置に出させるため、端末のカーソルを入力位置へ置く
  if (acceptsText && metrics.hasMeasured) {
    setCursorPosition({
      x: metrics.left + 2 + PROMPT.length + view.cursorCol,
      y: metrics.top + 1 + view.cursorRow,
    });
  } else {
    setCursorPosition(undefined);
  }

  return (
    <Box flexDirection="column" width={columns}>
      {snap.streaming !== '' ? <Text>{snap.streaming}</Text> : null}
      {snap.toolTail.map((l, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {`    ${l}`}
        </Text>
      ))}
      {snap.busy ? <Busy label={snap.busy.label} since={snap.busy.since} /> : null}
      {snap.dialog ? <DialogView dialog={snap.dialog} /> : null}
      {snap.inputHint ? <Text color={accentColor()}>{snap.inputHint}</Text> : null}
      <Box
        ref={inputRef}
        borderStyle="round"
        borderColor={acceptsText ? accentColor() : undefined}
        borderDimColor={!acceptsText}
        paddingX={1}
        flexDirection="column"
      >
        {view.rows.map((row, i) => (
          <Text key={i}>
            <Text color={accentColor()} dimColor={!acceptsText}>
              {i === 0 ? PROMPT : '  '}
            </Text>
            {row === '' && i === 0 && editor.text === '' ? (
              <Text dimColor>{placeholder(snap, acceptsText)}</Text>
            ) : (
              row
            )}
          </Text>
        ))}
      </Box>
      <StatusLine snap={snap} />
    </Box>
  );
}

function placeholder(snap: Snapshot, acceptsText: boolean): string {
  if (snap.dialog) return '上の選択肢を選んでください';
  if (!acceptsText) return '実行中です。Esc で止められます';
  return '';
}

function Busy({ label, since }: { label: string; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((now - since) / 1000);
  const frame = SPINNER[Math.floor(now / 100) % SPINNER.length];
  return (
    <Text>
      <Text color={accentColor()}>{frame}</Text>
      <Text>{` ${label} ${secs}秒`}</Text>
      <Text dimColor> · Esc で停止</Text>
    </Text>
  );
}

function DialogView({ dialog }: { dialog: Dialog }) {
  return (
    <Box borderStyle="round" borderColor={accentColor()} flexDirection="column" paddingX={1}>
      <Text bold color={accentColor()}>
        {dialog.title}
      </Text>
      {dialog.body.map((l, i) => (
        <LineView key={i} line={l} />
      ))}
      <Box flexDirection="column" marginTop={1}>
        {dialog.options.map((o, i) => (
          <Text key={o.key}>
            <Text color={accentColor()}>{i === dialog.selected ? '› ' : '  '}</Text>
            <Text bold={i === dialog.selected}>{o.label}</Text>
            <Text dimColor>{` (${o.key})`}</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>↑↓ で選んで Enter、または括弧の中のキー。Esc で拒否</Text>
    </Box>
  );
}

function StatusLine({ snap }: { snap: Snapshot }) {
  if (snap.exitPending) {
    return <Text color={accentColor()}>もう一度 Ctrl+C で終了します（/exit でも終了）</Text>;
  }
  const s = snap.status;
  const parts = [s.model];
  if (s.permission) parts.push(describePermission(s.permission));
  parts.push(s.tools);
  if (s.context) parts.push(s.context);
  return (
    <Text dimColor wrap="truncate-end">
      {`  ${parts.join(' · ')}   /help${s.permission ? ' · Shift+Tab で権限' : ''}`}
    </Text>
  );
}

function describePermission(m: PermissionMode): string {
  return m === 'ask' ? '承認する' : m === 'autoEdit' ? '編集は自動' : 'すべて自動';
}

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'header':
      return (
        <Box borderStyle="round" borderColor={accentColor()} flexDirection="column" paddingX={1}>
          <Text bold color={accentColor()}>
            {item.title}
          </Text>
          {item.lines.map((l, i) => (
            <LineView key={i} line={l} />
          ))}
        </Box>
      );
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={accentColor()}>{PROMPT}</Text>
          <Text bold>{item.text}</Text>
        </Box>
      );
    case 'assistant':
      return <Text>{item.text}</Text>;
    case 'lines':
      return (
        <Box flexDirection="column">
          {item.lines.map((l, i) => (
            <LineView key={i} line={l} />
          ))}
        </Box>
      );
  }
}

function LineView({ line }: { line: Line }) {
  return (
    <Text>
      {line.map((s, i) => (
        <Text key={i} {...styleOf(s.tone)}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
