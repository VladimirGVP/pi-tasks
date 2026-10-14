import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "../../src/model.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallOutcome,
	ToolDefinition,
	ToolResult,
} from "../../src/pi-types.ts";
import { replayTaskEvents } from "../../src/reducer.ts";
import { buildTaskResume } from "../../src/render.ts";
import {
	type BranchEntry,
	createTaskRuntimeStore,
	snapshotState,
} from "../../src/store.ts";
import { registerTaskTools } from "../../src/tools.ts";
import {
	RECEIPT_ENTRY,
	type VerificationReceipt,
} from "../../src/verification.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function nativeOutcome(
	name: string,
	args: Record<string, unknown>,
	result: ToolResult,
): ToolCallOutcome {
	return {
		toolCall: { id: "fixture-native/1", name, arguments: args },
		durationMs: 1,
		isError: result.isError === true,
		result,
	};
}

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tasks-verification-"));
	roots.push(cwd);
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
	git("init", "-q");
	writeFileSync(join(cwd, ".gitignore"), "reports/\n");
	writeFileSync(join(cwd, "source.ts"), "export const answer = 42;\n");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-qm",
		"fixture",
	);
	mkdirSync(join(cwd, "reports"));
	const reportPath = join(cwd, "reports", "result.json");
	const tools = new Map<string, ToolDefinition<Record<string, unknown>>>();
	const entries: BranchEntry[] = [];
	const pi: ExtensionAPI = {
		events: { emit() {} },
		on() {},
		registerCommand() {},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		appendEntry(customType, data) {
			entries.push({ type: "custom", customType, data });
		},
	};
	const ctx: ExtensionContext = {
		cwd,
		sessionManager: {
			getBranch: () => entries,
			getSessionId: () => "fixture-session",
		},
		ui: { notify() {}, setStatus() {}, setWidget() {} },
		executeTool: async (name, args) => {
			expect(name).toBe("bash");
			writeFileSync(
				reportPath,
				JSON.stringify({ success: true, numFailedTests: 0 }),
			);
			return nativeOutcome(name, args, {
				content: [{ type: "text", text: "1 test passed" }],
				structuredContent: { exit_code: 0, output: "1 test passed" },
			});
		},
	};
	const store = createTaskRuntimeStore();
	registerTaskTools(pi, store);
	const call = async (name: string, params: Record<string, unknown>) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing tool ${name}`);
		return tool.execute(`fixture-${name}`, params, undefined, undefined, ctx);
	};
	const plan = await call("task_plan", {
		title: "Verify synthetic source",
		objective: "Verify one safe fixture",
		acceptance_criteria: ["Observed verification is bound"],
		plan_steps: [
			{
				text: "Test source behavior",
				expectedOutput: "A persisted verification report",
				allowedActions: ["Test source"],
				decompositionStatus: "atomic",
				granularityCheck: {
					isAtomic: true,
					reason: "One test output",
					canBeDoneInOneAgentAction: true,
					hasSingleObservableOutput: true,
					hasSingleVerificationMethod: true,
					hasNoHiddenSubtasks: true,
				},
			},
		],
	});
	expect(plan.isError).not.toBe(true);
	const command = `printf '{"success":true,"numFailedTests":0}\\n' > reports/result.json`;
	const verify = () =>
		call("task_verify", { task_id: "T1", command, artifactRefs: [reportPath] });
	const evidenceParams = (receiptId?: string) => ({
		task_id: "T1",
		type: "test",
		level: "unit_test",
		passed: "true",
		summary: "Observed verification passed: one fixture",
		references: [reportPath],
		criterion_ids: ["T1-AC1"],
		step_ids: ["T1-S1"],
		quality: {
			source: "fixture",
			reproducible: true,
			verifier: "tool",
			command,
			artifactRefs: [reportPath],
			observedOutput: "1 test passed",
			...(receiptId ? { receiptId } : {}),
		},
	});
	const evidence = (receiptId?: string) =>
		call("task_evidence", evidenceParams(receiptId));
	const closeStep = () =>
		call("task_update", {
			task_id: "T1",
			step_id: "T1-S1",
			step_status: "done",
		});
	const complete = (extra: Record<string, unknown> = {}) =>
		call("task_complete", {
			task_id: "T1",
			summary: "Fixture checked",
			evidence_ids: [store.getState().tasks.T1?.evidence.at(-1)?.id ?? "E1"],
			...extra,
		});
	const receipt = () =>
		(
			entries.findLast((entry) => entry.customType === RECEIPT_ENTRY)
				?.data as VerificationReceipt
		).id;
	return {
		cwd,
		reportPath,
		ctx,
		entries,
		tools,
		pi,
		store,
		call,
		command,
		verify,
		evidence,
		evidenceParams,
		closeStep,
		complete,
		receipt,
	};
}

async function supportedFixture() {
	const f = await fixture();
	await f.verify();
	await f.evidence(f.receipt());
	await f.closeStep();
	return f;
}

function errorText(
	result: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["complete"]>>,
) {
	return result.content.map((item) => item.text).join("\n");
}

describe("runtime evidence trust boundary", () => {
	it("does not accept passing caller claims for ordinary Done", async () => {
		const f = await fixture();
		await f.evidence();
		await f.closeStep();
		const result = await f.complete();
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("runtime-verified");
		expect(f.store.getState().tasks.T1?.status).toBe("active");
	});

	it("accepts an observed success, then preserves binding through replay/snapshot", async () => {
		const f = await supportedFixture();
		f.store.append(
			{
				version: 1,
				id: "snapshot",
				type: "task.snapshot",
				taskId: "T1",
				createdAt: new Date().toISOString(),
				source: "system",
				state: snapshotState(f.store.getState()),
				reason: "manual",
				resume: {
					currentStepLineage: [],
					evidenceIds: [],
					criterionIds: [],
					allowedActions: [],
					nextAllowedActions: [],
					verificationGaps: [],
					blockers: [],
					decisions: [],
					warnings: [],
					resumeInstruction: "fixture",
				},
			},
			(customType, data) => f.pi.appendEntry(customType, data),
		);
		expect(f.store.replay(f.entries).malformedEvents).toEqual([]);
		const result = await f.complete();
		expect(result.isError).not.toBe(true);
		expect(f.store.getState().tasks.T1?.completionKind).toBe(
			"verified_execution",
		);
	});

	it.each(["arbitrary-call-id", "made-up-receipt"])(
		"rejects unobserved receipt %s",
		async (id) => {
			const f = await fixture();
			await expect(f.evidence(id)).rejects.toThrow("missing or ambiguous");
		},
	);

	it.each([1, undefined, "0"])(
		"refuses failed/unknown native exit %s",
		async (exit) => {
			const f = await fixture();
			f.ctx.executeTool = async (name, args) =>
				nativeOutcome(name, args, {
					content: [],
					structuredContent: { exit_code: exit },
				});
			await expect(f.verify()).rejects.toThrow("observed native bash");
			expect(
				f.entries.some((entry) => entry.customType === RECEIPT_ENTRY),
			).toBe(false);
		},
	);

	it("does not accept an isError result even with exit_code=0", async () => {
		const f = await fixture();
		f.ctx.executeTool = async (name, args) =>
			nativeOutcome(name, args, {
				content: [],
				isError: true,
				structuredContent: { exit_code: 0 },
			});
		await expect(f.verify()).rejects.toThrow("observed native bash");
	});

	it.each([
		{ exitCode: 1 },
		{ success: false },
		{ numFailedTests: 2 },
		{ testResults: [{ status: "failed" }] },
	])("rejects failed JSON report %j", async (report) => {
		const f = await fixture();
		f.ctx.executeTool = async (name, args) => {
			writeFileSync(f.reportPath, JSON.stringify(report));
			return nativeOutcome(name, args, {
				content: [],
				structuredContent: { exit_code: 0 },
			});
		};
		await expect(f.verify()).rejects.toThrow("failed outcome");
	});

	it("rejects missing report files", async () => {
		const f = await fixture();
		f.ctx.executeTool = async (name, args) =>
			nativeOutcome(name, args, {
				content: [],
				structuredContent: { exit_code: 0 },
			});
		await expect(f.verify()).rejects.toThrow("ENOENT");
	});

	it("rejects preexisting reports not produced by this run", async () => {
		const f = await fixture();
		writeFileSync(f.reportPath, '{"success":true}');
		f.ctx.executeTool = async (name, args) =>
			nativeOutcome(name, args, {
				content: [],
				structuredContent: { exit_code: 0 },
			});
		await expect(f.verify()).rejects.toThrow("not produced");
	});

	it.each([
		"missing",
		"failed",
		"different-pass",
		"source",
		"untracked-source",
		"session",
		"branch",
	])("rechecks %s at completion", async (change) => {
		const f = await supportedFixture();
		if (change === "missing") unlinkSync(f.reportPath);
		if (change === "failed") writeFileSync(f.reportPath, '{"exit_code":1}');
		if (change === "different-pass")
			writeFileSync(f.reportPath, '{"success":true}');
		if (change === "source")
			writeFileSync(join(f.cwd, "source.ts"), "broken\n");
		if (change === "untracked-source")
			writeFileSync(join(f.cwd, "new.ts"), "unverified\n");
		if (change === "session")
			f.ctx.sessionManager.getSessionId = () => "other-session";
		if (change === "branch")
			f.entries.splice(
				f.entries.findIndex((entry) => entry.customType === RECEIPT_ENTRY),
				1,
			);
		const result = await f.complete();
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("runtime-verified");
	});

	it("revalidates a duplicate rather than returning old passing evidence", async () => {
		const f = await supportedFixture();
		writeFileSync(f.reportPath, '{"exit_code":1}');
		await expect(f.evidence(f.receipt())).rejects.toThrow("failed outcome");
	});

	it("does not deduplicate a runtime-bound rerun into an unbound claim", async () => {
		const f = await fixture();
		await f.evidence();
		await f.verify();
		await f.evidence(f.receipt());
		expect(f.store.getState().tasks.T1?.evidence).toHaveLength(2);
		await f.closeStep();
		expect((await f.complete()).isError).not.toBe(true);
	});

	it("requires current support on the criterion and step, not only explicit completion IDs", async () => {
		const f = await supportedFixture();
		const task = f.store.getState().tasks.T1;
		if (!task) throw new Error("Missing task");
		const criterion = task.acceptanceCriteria[0];
		if (!criterion) throw new Error("Missing criterion");
		// Simulate a valid imported historical claim in a different support lineage.
		const original = task.evidence[0];
		if (!original) throw new Error("Missing evidence");
		const { verification: _binding, ...claim } = original;
		task.evidence.push({
			...claim,
			id: "historical",
			quality: { ...claim.quality, receiptId: "missing" },
		});
		criterion.evidenceIds = ["historical"];
		const result = await f.complete({ evidence_ids: [original.id] });
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("Criterion T1-AC1 requires current");
		criterion.evidenceIds = [original.id];
		const step = task.planSteps[0];
		if (!step) throw new Error("Missing step");
		step.evidenceIds = ["historical"];
		expect(
			errorText(await f.complete({ evidence_ids: [original.id] })),
		).toContain("Plan step T1-S1 requires current");
	});

	it("never clears forced completion provenance through warning resolution", async () => {
		const f = await fixture();
		const result = await f.complete({
			evidence_ids: [],
			force_with_reason: "Known verification gap",
		});
		expect(result.isError).not.toBe(true);
		expect(f.store.getState().tasks.T1?.completionKind).toBe("forced");
		const cleared = await f.call("task_update", {
			task_id: "T1",
			resolve_warnings: ["Forced"],
		});
		expect(cleared.isError).toBe(true);
		expect(f.store.getState().tasks.T1?.warnings).toContain(
			"Forced completion: Known verification gap",
		);
		f.store.replay(f.entries);
		expect(f.store.getState().tasks.T1?.completionKind).toBe("forced");
	});

	it("rejects unknown flat results and unexecuted outcomes", async () => {
		const f = await fixture();
		f.ctx.executeTool = async () =>
			({
				content: [],
				structuredContent: { exit_code: 0 },
			}) as unknown as ToolCallOutcome;
		await expect(f.verify()).rejects.toThrow("observed native bash");
		f.ctx.executeTool = async (name, args) => {
			const result = nativeOutcome(name, args, {
				content: [],
				structuredContent: { exit_code: 0 },
			});
			delete result.durationMs;
			return result;
		};
		await expect(f.verify()).rejects.toThrow("observed native bash");
	});

	it("does not let a stale rerun hide failure behind unrelated current evidence", async () => {
		const f = await supportedFixture();
		const task = f.store.getState().tasks.T1;
		if (!task) throw new Error("Missing task");
		const current = task.evidence[0];
		const criterion = task.acceptanceCriteria[0];
		if (!current || !criterion)
			throw new Error("Missing evidence or criterion");
		task.evidence.push({
			...current,
			id: "failed",
			passed: false,
			createdAt: new Date(0).toISOString(),
		});
		task.evidence.push({
			...current,
			id: "stale-rerun",
			createdAt: new Date(1000).toISOString(),
			supersedes: ["failed"],
			quality: { ...current.quality, receiptId: "missing" },
			verification: { receiptId: "missing" },
		});
		criterion.evidenceIds = ["failed", "stale-rerun", current.id];
		const result = await f.complete({ evidence_ids: [current.id] });
		expect(result.isError).toBe(true);
		expect(errorText(result)).toContain("current verified rerun");
	});

	it("keeps forced provenance and confidence cap on repeated completion", async () => {
		const f = await supportedFixture();
		expect(
			(await f.complete({ force_with_reason: "Owner-visible gap" })).isError,
		).not.toBe(true);
		expect((await f.complete()).isError).not.toBe(true);
		expect(f.store.getState().tasks.T1?.completionKind).toBe("forced");
		expect(f.store.getState().tasks.T1?.confidence).toBeLessThan(80);
	});

	it.each(["skipped-step", "skipped-criterion", "optional-step"])(
		"requires fresh superseders even in %s",
		async (scope) => {
			const f = await supportedFixture();
			const task = f.store.getState().tasks.T1;
			if (!task) throw new Error("Missing task");
			const current = task.evidence[0];
			const step = task.planSteps[0];
			const criterion = task.acceptanceCriteria[0];
			if (!current || !step || !criterion)
				throw new Error("Missing fixture support");
			task.evidence.push({
				...current,
				id: "failed",
				passed: false,
				createdAt: new Date(0).toISOString(),
			});
			task.evidence.push({
				...current,
				id: "stale",
				createdAt: new Date(1000).toISOString(),
				supersedes: ["failed"],
				quality: { ...current.quality, receiptId: "missing" },
				verification: { receiptId: "missing" },
			});
			if (scope === "skipped-criterion") {
				criterion.status = "skipped";
				criterion.note = "Explicitly deferred scope";
				criterion.evidenceIds = ["failed", "stale"];
			} else {
				step.status = scope === "skipped-step" ? "skipped" : "done";
				step.evidenceRequired = scope !== "optional-step";
				step.note = "Explicitly deferred scope";
				step.evidenceIds = ["failed", "stale"];
			}
			const result = await f.complete({ evidence_ids: [current.id] });
			expect(result.isError).toBe(true);
			expect(errorText(result)).toContain("current verified rerun");
			// A genuinely current superseder resolves the failure; skipping alone cannot.
			current.supersedes = ["failed"];
			if (scope === "skipped-criterion") criterion.evidenceIds.push(current.id);
			else step.evidenceIds.push(current.id);
			expect(
				(await f.complete({ evidence_ids: [current.id] })).isError,
			).not.toBe(true);
		},
	);

	it("records verified-to-forced repeat as forced even when reports become invalid", async () => {
		const f = await supportedFixture();
		expect((await f.complete()).isError).not.toBe(true);
		unlinkSync(f.reportPath);
		expect(
			(
				await f.complete({
					evidence_ids: [],
					force_with_reason: "Report no longer current",
				})
			).isError,
		).not.toBe(true);
		expect(f.store.getState().tasks.T1?.completionKind).toBe("forced");
		expect(f.store.getState().tasks.T1?.confidence).toBeLessThan(80);
		f.store.replay(f.entries);
		expect(f.store.getState().tasks.T1?.completionKind).toBe("forced");
		expect(f.store.getState().tasks.T1?.confidence).toBeLessThan(80);
	});

	it("restores legacy Done through both exported replay paths without certifying it", async () => {
		const f = await fixture();
		await f.evidence();
		await f.closeStep();
		const legacy: TaskEvent = {
			version: 1,
			id: "legacy-done",
			taskId: "T1",
			type: "task.completed",
			createdAt: new Date().toISOString(),
			source: "tool",
			summary: "Historical claim",
			evidenceIds: ["E1"],
		};
		expect(() => f.store.append(legacy, () => {})).toThrow("runtime-verified");
		f.entries.push({
			type: "custom",
			customType: "pi-tasks:event",
			data: legacy,
		});
		const events = f.entries
			.filter((entry) => entry.customType === "pi-tasks:event")
			.map((entry) => entry.data as TaskEvent);
		const replayed = replayTaskEvents(events);
		const branch = f.store.replay(f.entries);
		expect(branch.malformedEvents).toEqual([]);
		expect(replayed.tasks.T1?.completionKind).toBe("legacy_unverified");
		expect(replayed.tasks.T1).toEqual(branch.state.tasks.T1);
	});

	it("resume directs unbound claims to receipt creation rather than completion", async () => {
		const f = await fixture();
		await f.evidence();
		await f.closeStep();
		const resume = buildTaskResume(f.store.getState());
		expect(resume.mode).toBe("verifying");
		expect(resume.recommendedTool).toBe("task_verify");
		expect(resume.nextAllowedActions).not.toContain("task_complete");
		expect(resume.verificationGaps.join(" ")).toContain("Receipt support:");
		expect(resume.minimumParams).toHaveProperty("artifactRefs");
		expect(resume.resumeInstruction).toContain("receiptId");
		await f.verify();
		await f.call("task_evidence", {
			...f.evidenceParams(f.receipt()),
			override_reason: "Bind verification to closed fixture step",
		});
		expect(buildTaskResume(f.store.getState()).recommendedTool).toBe(
			"task_complete",
		);
	});

	it("rejects source changes during verification", async () => {
		const f = await fixture();
		const run = f.ctx.executeTool;
		if (!run) throw new Error("Missing native execution adapter");
		f.ctx.executeTool = async (name, args, options) => {
			const outcome = await run(name, args, options);
			writeFileSync(join(f.cwd, "source.ts"), "changed during verification\n");
			return outcome;
		};
		await expect(f.verify()).rejects.toThrow("changed during verification");
	});

	it("fails closed on runtimes without native executeTool", async () => {
		const f = await fixture();
		delete f.ctx.executeTool;
		await expect(f.verify()).rejects.toThrow("unavailable");
	});

	it.skipIf(!process.env.PI_TEST_NATIVE_BASH_PATH)(
		"real installed SDK bash → report → receipt → evidence → Done",
		async () => {
			const f = await fixture();
			const sdk = await import(process.env.PI_TEST_NATIVE_BASH_PATH as string);
			const bash = sdk.createBashToolDefinition(f.cwd, {
				exposeSessionEnvironment: false,
			});
			f.ctx.executeTool = async (name, args, options) => {
				expect(name).toBe("bash");
				return nativeOutcome(
					name,
					args,
					await bash.execute(
						"fixture-native/1",
						args,
						options?.signal,
						undefined,
						f.ctx,
					),
				);
			};
			await f.verify();
			await f.evidence(f.receipt());
			await f.closeStep();
			expect((await f.complete()).isError).not.toBe(true);
			expect(f.store.getState().tasks.T1?.completionKind).toBe(
				"verified_execution",
			);
		},
	);
});
