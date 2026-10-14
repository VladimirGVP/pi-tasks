import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Task, TaskEvidence } from "./model.ts";
import type { ExtensionAPI, ExtensionContext } from "./pi-types.ts";

export const RECEIPT_ENTRY = "pi-tasks:verification-v1";
const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export interface VerificationReceipt {
	version: 1;
	id: string;
	taskId: string;
	contractHash: string;
	sessionId: string;
	cwd: string;
	command: string;
	toolCallId: string;
	workspaceHash: string;
	artifacts: Array<{ path: string; hash: string }>;
	outputHash: string;
	createdAt: string;
}

export interface VerificationBinding {
	receiptId: string;
}

function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function identity(ctx: ExtensionContext): { cwd: string; sessionId: string } {
	const sessionId = ctx.sessionManager.getSessionId?.();
	if (!ctx.cwd || !sessionId)
		throw new Error("Verification requires cwd and session identity");
	return { cwd: realpathSync(ctx.cwd), sessionId };
}

function git(cwd: string, args: string[]): Buffer {
	return execFileSync("git", ["-C", cwd, ...args], {
		maxBuffer: 4 * 1024 * 1024,
		timeout: 10000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/** Include tracked modifications/deletions and non-ignored new sources, not just HEAD. */
export function workspaceHash(cwd: string): string {
	const root = git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim();
	const head = git(root, ["rev-parse", "HEAD"]).toString().trim();
	const paths = [
		...new Set(
			git(root, [
				"ls-files",
				"--cached",
				"--others",
				"--exclude-standard",
				"-z",
			])
				.toString()
				.split("\0")
				.filter(Boolean),
		),
	].sort();
	if (paths.length > 20000)
		throw new Error("Verification source tree exceeds file limit");
	const hash = createHash("sha256").update(JSON.stringify({ root, head }));
	let bytes = 0;
	for (const path of paths) {
		const absolute = join(root, path);
		let stat: import("node:fs").Stats;
		try {
			stat = lstatSync(absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			hash.update(JSON.stringify([path, "deleted"]));
			continue;
		}
		if (!stat.isFile())
			throw new Error(`Unsupported source entry (symlink/submodule): ${path}`);
		bytes += stat.size;
		if (bytes > MAX_SOURCE_BYTES)
			throw new Error("Verification source tree exceeds byte limit");
		const content = readFileSync(absolute);
		hash.update(JSON.stringify([path, stat.mode, digest(content)]));
	}
	return hash.digest("hex");
}

function contractHash(task: Task): string {
	return digest(
		JSON.stringify([
			task.id,
			task.title,
			task.objective,
			task.createdAt,
			task.acceptanceCriteria.map(({ id, text }) => ({ id, text })),
		]),
	);
}

function explicitFailure(value: unknown, depth = 0): boolean {
	if (!value || typeof value !== "object" || depth > 12) return false;
	return Object.entries(value).some(
		([key, child]) =>
			(["exitCode", "exit_code"].includes(key) &&
				typeof child === "number" &&
				child !== 0) ||
			(["success", "passed"].includes(key) && child === false) ||
			([
				"numFailedTests",
				"numFailedTestSuites",
				"failures",
				"errors",
				"failed",
			].includes(key) &&
				typeof child === "number" &&
				child > 0) ||
			(key === "status" &&
				["failed", "failure", "error", "timedOut"].includes(String(child))) ||
			explicitFailure(child, depth + 1),
	);
}

function report(path: string): { path: string; hash: string } {
	// Symlinks (including changed targets) are not accepted as report identities.
	if (!lstatSync(path).isFile())
		throw new Error(`Verification report is not a regular file: ${path}`);
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical);
	if (stat.size === 0 || stat.size > MAX_REPORT_BYTES)
		throw new Error(`Verification report has invalid size: ${path}`);
	const content = readFileSync(canonical);
	if (path.endsWith(".json")) {
		const parsed: unknown = JSON.parse(content.toString());
		if (explicitFailure(parsed))
			throw new Error(`Verification report contains a failed outcome: ${path}`);
	}
	return { path: canonical, hash: digest(content) };
}

function pathsFor(cwd: string, paths: string[]): string[] {
	if (!paths.length || paths.length > 20)
		throw new Error("Verification requires 1–20 local report files");
	return [
		...new Set(
			paths.map((path) => (isAbsolute(path) ? path : resolve(cwd, path))),
		),
	].sort();
}

export async function runVerification(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	task: Task,
	params: { command: string; artifactRefs: string[]; timeout?: number },
	signal?: AbortSignal,
): Promise<VerificationReceipt> {
	if (!ctx.executeTool)
		throw new Error(
			"Native executeTool is unavailable; verification is unsupported",
		);
	if (!params.command.trim())
		throw new Error("Verification command is required");
	const initial = identity(ctx);
	const paths = pathsFor(initial.cwd, params.artifactRefs);
	const before = workspaceHash(initial.cwd);
	const previousReports = paths.map((path) => {
		try {
			const stat = lstatSync(path, { bigint: true });
			return `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
	});
	const outcome = await ctx.executeTool(
		"bash",
		{
			command: params.command,
			...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
		},
		signal ? { signal } : {},
	);
	// Native executeTool returns an outcome envelope after normal tool hooks.
	// Flat tool results, blocked calls and unknown adapters fail closed.
	if (
		signal?.aborted ||
		outcome?.isError !== false ||
		outcome.result?.isError ||
		outcome.toolCall?.name !== "bash" ||
		!outcome.toolCall.id ||
		outcome.toolCall.arguments?.command !== params.command ||
		typeof outcome.durationMs !== "number" ||
		!Number.isFinite(outcome.durationMs) ||
		outcome.durationMs < 0 ||
		(outcome.result?.structuredContent as { exit_code?: unknown } | undefined)
			?.exit_code !== 0
	) {
		throw new Error(
			"Verification requires an observed native bash exit_code=0; failed/unknown results cannot mint receipts",
		);
	}
	const current = identity(ctx);
	if (
		current.cwd !== initial.cwd ||
		current.sessionId !== initial.sessionId ||
		workspaceHash(initial.cwd) !== before
	) {
		throw new Error(
			"Source/session changed during verification; rerun against a stable workspace",
		);
	}
	for (const [index, path] of paths.entries()) {
		const stat = lstatSync(path, { bigint: true });
		if (`${stat.ino}:${stat.mtimeNs}:${stat.size}` === previousReports[index])
			throw new Error(
				`Verification report was not produced by this run: ${path}`,
			);
	}
	const receipt: VerificationReceipt = {
		version: 1,
		id: randomUUID(),
		taskId: task.id,
		contractHash: contractHash(task),
		...initial,
		command: params.command.trim(),
		toolCallId: outcome.toolCall.id,
		workspaceHash: before,
		artifacts: paths.map(report),
		outputHash: digest(JSON.stringify(outcome.result.structuredContent)),
		createdAt: new Date().toISOString(),
	};
	pi.appendEntry(RECEIPT_ENTRY, receipt);
	return receipt;
}

/** Only runtime entries on this branch are authoritative; caller-supplied receipt objects are never read. */
export function bindEvidence(
	ctx: ExtensionContext,
	task: Task,
	evidence: Pick<TaskEvidence, "quality" | "passed">,
): VerificationBinding | undefined {
	const id = evidence.quality.receiptId;
	if (!id) return undefined; // Legacy claims remain inspectable, but cannot authorize Done.
	if (evidence.passed !== true)
		throw new Error("Receipt binding requires passing evidence");
	const matches = ctx.sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === RECEIPT_ENTRY &&
				(entry.data as VerificationReceipt | undefined)?.id === id,
		);
	if (matches.length !== 1)
		throw new Error(
			"Verification receipt is missing or ambiguous on this branch",
		);
	const receipt = matches[0]?.data as VerificationReceipt;
	const { cwd, sessionId } = identity(ctx);
	if (
		receipt.version !== 1 ||
		receipt.taskId !== task.id ||
		receipt.contractHash !== contractHash(task) ||
		receipt.sessionId !== sessionId ||
		receipt.cwd !== cwd ||
		receipt.command !== evidence.quality.command?.trim()
	) {
		throw new Error(
			"Verification receipt task/session/command binding mismatch",
		);
	}
	if (workspaceHash(cwd) !== receipt.workspaceHash)
		throw new Error("Verification receipt is stale: source content changed");
	const current = pathsFor(cwd, evidence.quality.artifactRefs)
		.map(report)
		.sort((a, b) => a.path.localeCompare(b.path));
	const expected = [...receipt.artifacts].sort((a, b) =>
		a.path.localeCompare(b.path),
	);
	if (JSON.stringify(current) !== JSON.stringify(expected))
		throw new Error("Verification report binding changed");
	return { receiptId: receipt.id };
}

/** Resolve all current positive candidates, never let a stale/claimed item provide acceptance. */
export function currentVerifiedEvidence(
	ctx: ExtensionContext,
	task: Task,
): string[] {
	const ids: string[] = [];
	for (const evidence of task.evidence) {
		if (evidence.passed !== true || !evidence.verification) continue;
		try {
			const binding = bindEvidence(ctx, task, evidence);
			if (binding?.receiptId === evidence.verification.receiptId)
				ids.push(evidence.id);
		} catch {
			// An invalid candidate grants no authority; reducer demands current support in every scope.
		}
	}
	return ids;
}
