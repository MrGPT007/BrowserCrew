import { now, uid, proposal } from './contracts.js';
import { allowed, verifyFindings } from './policy.js';

export class Engine {
  constructor({ store, browser, provider }) {
    this.store = store; this.browser = browser; this.provider = provider;
    this.tasks = []; this.busy = false; this.controller = null; this.active = null;
  }
  async init() {
    this.tasks = await this.store.list();
    for (const task of [...this.tasks]) {
      if (Date.now() - Date.parse(task.createdAt) > 30 * 86400000) {
        await this.store.remove(task.id); this.tasks = this.tasks.filter(t => t.id !== task.id); continue;
      }
      const uncertain = task.actions.some(a => a.status === 'intent');
      if (uncertain || task.status === 'running' || task.status === 'awaiting_approval') {
        for (const action of task.actions) if (action.status === 'intent') action.status = 'outcome_unknown';
        task.status = task.actions.some(a => a.status === 'outcome_unknown') ? 'recovering' : 'paused';
        task.pending = null;
        task.reason = task.status === 'recovering' ? 'A form change may have happened before the browser stopped. Inspect the form; this task will not repeat the change.' : 'The browser stopped before this task finished. Resume to read the current pages again.';
        await this.persist(task);
      }
    }
  }
  get(id) { const task = this.tasks.find(t => t.id === id); if (!task) throw new Error('This saved task was not found.'); return task; }
  async persist(task, message) {
    task.updatedAt = now();
    if (message) task.events.push({ at: now(), text: message });
    task.events = task.events.slice(-100);
    try { await this.store.save(task); }
    catch (error) { task.status = 'failed'; task.reason = error.message; this.controller?.abort(); throw error; }
  }
  async start(input) {
    if (this.busy || this.tasks.some(t => ['running', 'awaiting_approval'].includes(t.status))) throw new Error('Pause or stop the current task before starting another.');
    const task = { id: uid(), schemaVersion: 1, createdAt: now(), updatedAt: now(), goal: input.goal,
      completionCriteria: input.completionCriteria, workflow: input.workflow, provider: input.provider, resources: input.resources,
      maxSteps: input.maxSteps, steps: 0, elapsedMs: 0, tokens: 0, usageKnown: true, status: 'running', reason: 'Reading your task.',
      observations: [], actions: [], findings: [], summary: '', missing: [], events: [], pending: null };
    // Reserve before the first await so concurrent UI messages cannot start another task.
    this.tasks.unshift(task);
    await this.persist(task, 'Task saved. Only your chosen pages and AI connection are allowed.');
    this.launch(task);
    return task.id;
  }
  launch(task) {
    if (this.busy) throw new Error('The previous action is still finishing. Try again in a moment.');
    this.busy = true; this.active = task.id; this.controller = new AbortController();
    this.running = this.run(task).finally(() => { this.busy = false; this.active = null; this.controller = null; });
    // Store errors already stop the task. Avoid an unhandled rejection in the worker.
    this.running.catch(() => {});
  }
  async run(task) {
    let tick = Date.now();
    try {
      while (task.status === 'running') {
        task.elapsedMs += Date.now() - tick; tick = Date.now();
        if (task.steps >= task.maxSteps || task.tokens >= 30000 || task.elapsedMs >= 600000) {
          task.status = 'paused'; task.reason = 'The task reached its step, time, or AI usage limit. Start a smaller task to continue.';
          await this.persist(task, task.reason); return;
        }
        task.reason = 'Your AI is choosing the next step.';
        await this.persist(task);
        if (task.status !== 'running') return;
        const answer = await this.provider(task, this.controller.signal);
        if (task.status !== 'running') return;
        task.steps++;
        task.tokens += answer.tokens ?? 0;
        if (answer.tokens === null) task.usageKnown = false;
        const action = proposal(answer.action);
        allowed(task, action);
        if (action.tool === 'read_page') {
          const observation = await this.browser.read(task, action.tabId);
          if (task.status !== 'running') return;
          task.observations = [...task.observations.filter(o => o.tabId !== action.tabId), observation];
          await this.persist(task, 'Read ' + observation.title + '.');
        } else if (action.tool === 'fill_fields') {
          if (task.actions.some(a => a.tool === 'fill_fields' && a.status === 'verified')) throw new Error('This form has already been filled. Start a new task for more changes.');
          task.pending = action; task.status = 'awaiting_approval'; task.reason = 'Review the exact field changes before filling the form.';
          task.actions.push({ id: uid(), at: now(), tool: action.tool, status: 'proposed', observationId: action.observationId, fields: action.fields });
          await this.persist(task, 'Form changes are ready for your review.'); return;
        } else {
          const complete = verifyFindings(task, action);
          task.findings = action.findings; task.summary = action.summary; task.missing = action.missing;
          task.status = complete ? 'completed' : 'partially_completed';
          task.reason = complete ? (task.workflow === 'form' ? 'The requested field values were checked. The form was not submitted.' : 'Source quotes match the selected pages. Review whether the answer meets your goal.') : 'Some requested work is missing. Review the results below.';
          await this.persist(task, task.reason); return;
        }
      }
    } catch (error) {
      if (task.status === 'running') {
        task.status = 'failed'; task.reason = error.message;
        await this.persist(task, task.reason);
      }
    } finally {
      task.elapsedMs += Date.now() - tick;
      await this.persist(task);
    }
  }
  async control(id, action) {
    const task = this.get(id);
    if (!['running', 'awaiting_approval', 'paused', 'recovering', 'failed'].includes(task.status)) throw new Error('This task has already ended.');
    task.status = action === 'stop' ? 'cancelled' : 'paused';
    task.reason = action === 'stop' ? 'Stopped. Changes already accepted by a website are not undone.' : action === 'takeover' ? 'You have control. Resume will read the pages again.' : 'Paused. No further steps will start.';
    task.pending = null;
    if (this.active === id) this.controller?.abort();
    await this.persist(task, task.reason);
  }
  async approve(id) {
    const task = this.get(id);
    if (this.busy || task.status !== 'awaiting_approval' || task.pending?.tool !== 'fill_fields') throw new Error('This approval is no longer current.');
    const change = structuredClone(task.pending);
    allowed(task, change);
    this.busy = true; this.active = id;
    task.pending = null; task.status = 'running';
    const action = task.actions.at(-1);
    action.status = 'intent';
    try {
      await this.persist(task, 'Your approved field changes were recorded before filling.');
      if (task.status !== 'running') { action.status = 'rejected'; await this.persist(task); return; }
      const result = await this.browser.fill(task, change);
      action.status = 'verified'; action.outcome = 'Checked ' + result.fields.length + ' field values. No submit action was dispatched.';
      action.result = result;
      if (task.status === 'running') {
        // After a write, finish with observed field outcomes, not a model assertion.
        task.status = 'completed'; task.reason = action.outcome; task.summary = 'The form is filled and ready for you to review on the page.';
      }
      await this.persist(task, action.outcome);
    } catch (error) {
      action.status = 'outcome_unknown'; action.outcome = error.message;
      if (task.status === 'running') task.status = 'recovering';
      task.reason = 'The form outcome is uncertain. Inspect the page. BrowserCrew will not repeat this change. ' + error.message;
      await this.persist(task, task.reason);
    } finally { this.busy = false; this.active = null; }
  }
  async resume(id) {
    const task = this.get(id);
    if (this.busy || this.tasks.some(t => t.id !== id && ['running', 'awaiting_approval'].includes(t.status))) throw new Error('Another action is still running. Wait for it to finish.');
    if (!['paused', 'failed'].includes(task.status)) throw new Error('This task cannot be resumed.');
    if (task.actions.some(a => ['intent', 'outcome_unknown'].includes(a.status))) throw new Error('A previous change has an unknown outcome. Inspect the page and start a new task.');
    if (task.steps >= task.maxSteps || task.tokens >= 30000 || task.elapsedMs >= 600000) throw new Error('This task reached its limit. Start a smaller task.');
    task.observations = []; task.pending = null; task.status = 'running'; task.reason = 'Reading the current pages again.';
    await this.persist(task, task.reason); this.launch(task);
  }
  async remove(id) {
    const task = this.get(id);
    if (this.active === id || ['running', 'awaiting_approval'].includes(task.status)) throw new Error('Stop the task before deleting it.');
    await this.store.remove(id); this.tasks = this.tasks.filter(t => t.id !== id);
  }
}
