import { spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionUIContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const DEFAULT_CONFIG: ZellijEditorConfig = {
	editor: "",
	floating: false,
	direction: "horizontal",
	height: "70%",
	width: "70%",
	showIndicator: true,
};

type ProcessResult = {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
};

type SessionState = {
	active: boolean;
};

export type ZellijDirection = "horizontal" | "vertical";

type ZellijEditorConfig = {
	/** Editor command. Empty string means: derive from $VISUAL/$EDITOR, fall back to nvim. */
	editor: string;
	/** Open the editor in an embedded split (false) or a floating pane (true). */
	floating: boolean;
	/** Split direction for embedded splits: "horizontal" opens right, "vertical" opens down. Ignored when floating. */
	direction: ZellijDirection;
	/** Floating pane height (zellij accepts bare integer or percent, e.g. "70%"). Ignored when not floating. */
	height: string;
	/** Floating pane width (zellij accepts bare integer or percent, e.g. "70%"). Ignored when not floating. */
	width: string;
	/** Render a "ZELLIJ EDITOR OPEN" label in the editor border while locked. */
	showIndicator: boolean;
};

type RawConfig = Partial<ZellijEditorConfig> & {
	zellijEditor?: Partial<ZellijEditorConfig>;
};

class ZellijEditor extends CustomEditor {
	private editing = false;
	private opening = false;
	private showIndicator = DEFAULT_CONFIG.showIndicator;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly appKeybindings: KeybindingsManager,
		private readonly ui: ExtensionUIContext,
		private readonly cwd: string,
		private readonly sessionState: SessionState,
	) {
		super(tui, theme, appKeybindings);
	}

	handleInput(data: string): void {
		// Intercept before CustomEditor's copied app handlers so pi's built-in
		// blocking external-editor action never runs.
		if (this.appKeybindings.matches(data, "app.editor.external")) {
			if (this.editing || this.opening) {
				this.ui.notify("zellij editor is already open", "warning");
				return;
			}

			if (!isInsideZellij()) {
				this.ui.notify(
					"zellij not detected; using pi's external editor; start zellij for split editing or disable zellij-editor to stop this warning.",
					"warning",
				);
				super.handleInput(data);
				return;
			}

			void this.openZellijEditor();
			return;
		}

		if (this.editing || this.opening) {
			// Lock the prompt while the zellij pane owns the editable copy.
			return;
		}

		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.editing || !this.showIndicator || lines.length === 0) return lines;

		const label = " ZELLIJ EDITOR OPEN ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, Math.max(0, width - label.length), "") + label;
		}
		return lines;
	}

	private async openZellijEditor(): Promise<void> {
		if (!isInsideZellij()) {
			this.ui.notify("zellij-editor requires zellij; Ctrl+G was ignored", "warning");
			return;
		}

		if (this.editing || this.opening) {
			this.ui.notify("zellij editor is already open", "warning");
			return;
		}

		this.opening = true;
		const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
		const tempFile = join(tmpdir(), `zellij-editor-${suffix}.md`);

		try {
			const config = await loadConfig(this.cwd);
			this.showIndicator = config.showIndicator;
			this.editing = true;
			this.opening = false;
			this.tui.requestRender();
			await writeFile(tempFile, this.getExpandedText(), "utf8");

			const editorCommand = resolveEditor(config.editor);
			const result = await openZellijPaneAndWait({
				tempFile,
				editorCommand,
				floating: config.floating,
				direction: config.direction,
				height: config.height,
				width: config.width,
			});

			if (result.code !== 0) {
				this.ui.notify(
					`zellij editor exited with status ${result.code ?? "?"}; reading temp file anyway`,
					"warning",
				);
			}

			const newText = (await readFile(tempFile, "utf8")).replace(/\n$/, "");
			if (this.sessionState.active) {
				this.setText(newText);
				this.tui.requestRender();
			}
		} catch (error) {
			this.ui.notify(`zellij-editor: ${formatError(error)}`, "error");
		} finally {
			this.editing = false;
			this.opening = false;
			await unlink(tempFile).catch(() => undefined);
			this.tui.requestRender();
		}
	}
}

function isInsideZellij(): boolean {
	// Zellij sets ZELLIJ=0 inside any session, ZELLIJ_SESSION_NAME, and ZELLIJ_PANE_ID.
	// The presence of ZELLIJ is the canonical signal.
	return process.env.ZELLIJ !== undefined;
}

async function openZellijPaneAndWait(options: {
	tempFile: string;
	editorCommand: string;
	floating: boolean;
	direction: ZellijDirection;
	height: string;
	width: string;
}): Promise<ProcessResult> {
	const args: string[] = ["action", "new-pane"];

	if (options.floating) {
		args.push("--floating");
		args.push("--width", options.width);
		args.push("--height", options.height);
	} else {
		// Zellij requires an explicit direction for non-floating splits.
		// horizontal -> open to the right, vertical -> open below.
		args.push("--direction", options.direction === "horizontal" ? "right" : "down");
	}

	args.push("--close-on-exit");
	args.push("--block-until-exit");
	// `--` separates zellij flags from the command to run in the new pane.
	// Zellij runs argv[0] with the rest as its argv (no shell involved), so
	// we parse the editor command into a program + argv ourselves. This keeps
	// the extension shell-agnostic — it works on Linux (zellij's default pane
	// shell) and on Windows (where there is no `sh` in PATH by default), and
	// it lets us pass Windows backslash paths with spaces through argv safely.
	const { program, args: editorArgs } = parseCommand(options.editorCommand);
	editorArgs.push(options.tempFile);
	args.push("--", program, ...editorArgs);

	return runProcess("zellij", args);
}

function resolveEditor(configured: string): string {
	const candidates = [
		configured,
		process.env.VISUAL,
		process.env.EDITOR,
		"nvim",
	];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && candidate.trim()) {
			return candidate.trim();
		}
	}
	// Unreachable: the literal "nvim" fallback always yields a non-empty value.
	return "nvim";
}

async function loadConfig(cwd: string): Promise<ZellijEditorConfig> {
	const globalConfig = normalizeRawConfig(
		await readJsonFile(join(getAgentDir(), "extensions", "zellij-editor.json")),
	);
	const projectConfig = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "zellij-editor.json")));
	const globalSettings = normalizeRawConfig(await readJsonFile(join(getAgentDir(), "settings.json")));
	const projectSettings = normalizeRawConfig(await readJsonFile(join(cwd, ".pi", "settings.json")));
	const envConfig = normalizeRawConfig({
		editor: process.env.ZELLIJ_EDITOR_EDITOR,
		floating: parseEnvBoolean(process.env.ZELLIJ_EDITOR_FLOATING),
		direction: process.env.ZELLIJ_EDITOR_DIRECTION,
		height: process.env.ZELLIJ_EDITOR_HEIGHT,
		width: process.env.ZELLIJ_EDITOR_WIDTH,
		showIndicator: parseEnvBoolean(process.env.ZELLIJ_EDITOR_SHOW_INDICATOR),
	});

	return {
		...DEFAULT_CONFIG,
		...globalConfig,
		...globalSettings,
		...projectConfig,
		...projectSettings,
		...envConfig,
	};
}

async function readJsonFile(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function normalizeRawConfig(raw: unknown): Partial<ZellijEditorConfig> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as RawConfig;
	const source =
		record.zellijEditor && typeof record.zellijEditor === "object" ? record.zellijEditor : record;
	const config: Partial<ZellijEditorConfig> = {};

	if (typeof source.editor === "string") config.editor = source.editor;
	if (typeof source.floating === "boolean") config.floating = source.floating;
	if (typeof source.direction === "string") {
		const normalized = source.direction.trim().toLowerCase();
		if (normalized === "horizontal" || normalized === "vertical") {
			config.direction = normalized;
		}
	}
	if (typeof source.height === "string" && source.height.trim()) config.height = source.height.trim();
	if (typeof source.width === "string" && source.width.trim()) config.width = source.width.trim();
	if (typeof source.showIndicator === "boolean") config.showIndicator = source.showIndicator;

	return config;
}

function parseEnvBoolean(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return undefined;
}

/**
 * Split a user-supplied editor command string into a program + argv, the way
 * a POSIX shell would tokenize it. Supports single- and double-quoted runs;
 * whitespace outside quotes separates tokens. Backslashes are literal (not
 * escape characters) so Windows paths round-trip cleanly when quoted or
 * space-free; paths with spaces must be quoted.
 *
 * Examples:
 *   "nvim"                                 -> { program: "nvim", args: [] }
 *   "code --wait"                          -> { program: "code", args: ["--wait"] }
 *   'nvim -c "set ft=markdown"'            -> { program: "nvim", args: ["-c", "set ft=markdown"] }
 *   '"C:\\Program Files\\Neovim\\bin\\nvim.exe"' -> { program: "C:\\Program Files\\Neovim\\bin\\nvim.exe", args: [] }
 */
function parseCommand(command: string): { program: string; args: string[] } {
	const tokens: string[] = [];
	let current = "";
	let inQuote: '"' | "'" | null = null;
	let hasCurrent = false;

	const flush = () => {
		if (hasCurrent) {
			tokens.push(current);
			current = "";
			hasCurrent = false;
		}
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (inQuote) {
			if (ch === inQuote) {
				inQuote = null;
			} else {
				current += ch;
				hasCurrent = true;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			inQuote = ch as '"' | "'";
			continue;
		}
		if (/\s/.test(ch)) {
			flush();
			continue;
		}
		current += ch;
		hasCurrent = true;
	}
	flush();

	const [program, ...args] = tokens;
	return { program: program ?? "", args };
}

function runProcess(command: string, args: string[]): Promise<ProcessResult> {
	// No shell: zellij's CLI expects args verbatim, and the editor invocation
	// is parsed into program + argv by the caller so we never need a shell.
	const child = spawn(command, args, {
		stdio: ["ignore", "ignore", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let stderr = "";
		let settled = false;

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = appendLimited(stderr, chunk.toString("utf8"));
		});

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});

		child.on("close", (code, signal) => {
			if (settled) return;
			settled = true;
			resolve({ code, signal, stderr });
		});
	});
}

function appendLimited(current: string, next: string, maxLength = 8192): string {
	const combined = current + next;
	return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	const sessionState: SessionState = { active: false };

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		sessionState.active = true;
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new ZellijEditor(tui, theme, keybindings, ctx.ui, ctx.cwd, sessionState),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		sessionState.active = false;
		ctx.ui.setEditorComponent(undefined);
	});
}
