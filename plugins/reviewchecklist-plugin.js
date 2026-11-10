/**
 * Review checklist plugin for Gerrit
 *
 * Adds a checklist to the reply dialog of a Gerrit change for configured repositories.
 * Tested with Gerrit 3.14.
 *
 * @link https://github.com/DataSCCource/reviewchecklist-gerrit-plugin
 * @version 0.4
 * @author Dennis W. (DataSCCource)
 * @since January 2022
 *
 * @usage Copy .js file to the plugins folder of your Gerrit installation and wait a minute.
 *        Add a .review-checklist.json file to the target branch of your repository:
 *          [
 *            {"id": "build", "checkpoint": "Checkpoint 1", "mandatory": true, "resetOnNewPatchset": true},
 *            {"id": "verify", "checkpoint": "Checkpoint 2", "mandatory": true, "label": "Verified", "threshold": 1},
 *            {"checkpoint": "Checkpoint 3 (not mandatory)"}
 *          ]
 *        'checkpoint'         - text of a checklist item
 *        'id'                 - optional; stable identifier, keeps the state when the text changes
 *        'mandatory'          - optional; an unchecked mandatory item prevents votes of 'threshold'
 *                               or higher on 'label'
 *        'label'              - optional; label restricted by a mandatory item, default "Code-Review"
 *        'threshold'          - optional; lowest restricted vote of a mandatory item, default 2
 *        'resetOnNewPatchset' - optional; item is unchecked again when a new patch set with code
 *                               changes is uploaded (not for trivial rebases or commit message edits)
 *
 *        Alternatively the file may contain an object {"label": ..., "threshold": ..., "items": [...]};
 *        'label' and 'threshold' then are the defaults for all items.
 *
 *        The state of the checklist is stored in the review message of each reply:
 *          Review checklist:
 *          [X] Checkpoint 1 (mandatory) {#build}
 *          [ ] Checkpoint 2 (not mandatory)
 *        Note: the restriction is enforced in the web UI only, not on the server.
 */

// Wrapped in a function so that no names leak into the global scope shared with other plugins.
(() => {
'use strict';

const PLUGIN_ELEMENT = 'reviewchecklist-plugin';
const CHECKLIST_FILE = '.review-checklist.json';
const DEFAULT_LABEL = 'Code-Review';
const DEFAULT_THRESHOLD = 2;
const MESSAGE_HEADER = 'Review checklist:';
// Header written by version 0.2 of this plugin, still understood when reading.
const LEGACY_MESSAGE_HEADER = 'Checklist:';
const ID_PATTERN = /^[A-Za-z0-9_.-]+$/;
// Patch set kinds after which items with 'resetOnNewPatchset' keep their state.
const TRIVIAL_KINDS = new Set([
  'TRIVIAL_REBASE',
  'TRIVIAL_REBASE_WITH_MESSAGE_UPDATE',
  'MERGE_FIRST_PARENT_UPDATE',
  'NO_CODE_CHANGE',
  'NO_CHANGE',
]);

/** The checklist element of the currently open reply dialog. */
let activeChecklist = null;

function labelValueAsNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).trim().replace('+', ''));
  return Number.isNaN(n) ? 0 : n;
}

/** Formats a vote the way Gerrit's label score rows expect it ("+1", " 0", "-1"). */
function formatLabelValue(n) {
  return n > 0 ? `+${n}` : n === 0 ? ' 0' : String(n);
}

/** Checkpoint text as a single line, as it is written into review messages. */
function singleLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeBase64Utf8(text) {
  const binary = atob(text.trim());
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function currentPatchsetNumber(change) {
  if (change.current_revision_number) return change.current_revision_number;
  const revisions = Object.values(change.revisions || {});
  return revisions.reduce((max, r) => Math.max(max, Number(r._number) || 0), 0);
}

/** True if all patch sets after 'from' up to 'to' are trivial (no code changes). */
function onlyTrivialPatchsets(change, from, to) {
  const kinds = new Map(Object.values(change.revisions || {}).map(r => [Number(r._number), r.kind]));
  for (let ps = from + 1; ps <= to; ps++) {
    if (!TRIVIAL_KINDS.has(kinds.get(ps))) return false;
  }
  return true;
}

class ConfigError extends Error {}

/** Parses and validates the content of the checklist file. Throws ConfigError. */
function parseConfig(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid JSON: ${err.message}`);
  }
  const cfg = Array.isArray(parsed) ? {items: parsed} : parsed;
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.items)) {
    throw new ConfigError('must contain an array of items or an object with an "items" array');
  }

  const errors = [];
  const checkLabel = (label, where) => {
    if (typeof label !== 'string' || !label.trim()) errors.push(`${where}"label" must be a non-empty string`);
  };
  const checkThreshold = (threshold, where) => {
    if (!Number.isInteger(threshold) || threshold < 1) errors.push(`${where}"threshold" must be an integer >= 1`);
  };
  const defaultLabel = cfg.label === undefined ? DEFAULT_LABEL : cfg.label;
  checkLabel(defaultLabel, '');
  const defaultThreshold = cfg.threshold === undefined ? DEFAULT_THRESHOLD : cfg.threshold;
  checkThreshold(defaultThreshold, '');

  const ids = new Set();
  const items = cfg.items.map((cp, i) => {
    const where = `item ${i + 1}`;
    if (!cp || typeof cp !== 'object') {
      errors.push(`${where}: must be an object`);
      return null;
    }
    if (typeof cp.checkpoint !== 'string' || !cp.checkpoint.trim()) {
      errors.push(`${where}: "checkpoint" must be a non-empty string`);
    }
    if (cp.id !== undefined) {
      if (typeof cp.id !== 'string' || !ID_PATTERN.test(cp.id)) {
        errors.push(`${where}: "id" may only contain letters, digits, "_", "." and "-"`);
      } else if (ids.has(cp.id)) {
        errors.push(`${where}: duplicate id "${cp.id}"`);
      }
      ids.add(cp.id);
    }
    for (const flag of ['mandatory', 'resetOnNewPatchset']) {
      if (cp[flag] !== undefined && typeof cp[flag] !== 'boolean') {
        errors.push(`${where}: "${flag}" must be true or false`);
      }
    }
    const label = cp.label === undefined ? defaultLabel : cp.label;
    if (cp.label !== undefined) checkLabel(label, `${where}: `);
    const threshold = cp.threshold === undefined ? defaultThreshold : cp.threshold;
    if (cp.threshold !== undefined) checkThreshold(threshold, `${where}: `);
    return {
      id: cp.id,
      checkpoint: typeof cp.checkpoint === 'string' ? cp.checkpoint.trim() : '',
      mandatory: cp.mandatory === true,
      resetOnNewPatchset: cp.resetOnNewPatchset === true,
      label: typeof label === 'string' ? label.trim() : '',
      threshold,
    };
  });

  if (errors.length > 0) throw new ConfigError(errors.join('; '));
  return {items};
}

/** Loads the checklist configuration of the change's target branch, or null if there is none. */
async function loadConfig(plugin, change) {
  const url =
    `/projects/${encodeURIComponent(change.project)}` +
    `/branches/${encodeURIComponent(change.branch)}` +
    `/files/${encodeURIComponent(CHECKLIST_FILE)}/content`;
  // errFn suppresses Gerrit's error dialog when the file does not exist.
  const response = await plugin.restApi().fetch('GET', url, undefined, () => {});
  if (!response || !response.ok) return null;
  return parseConfig(decodeBase64Utf8(await response.text()));
}

/**
 * Finds the checklist state stored in the latest review message of the given account.
 * Returns {patchset, byId: Map<id, boolean>, byText: Map<text, boolean>} or null.
 */
function parseSavedState(messages, accountId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg.author || msg.author._account_id !== accountId) continue;
    const lines = (msg.message || '').split('\n');
    const start = lines.findIndex(
      l => l.trim() === MESSAGE_HEADER || l.trim() === LEGACY_MESSAGE_HEADER
    );
    if (start < 0) continue;
    const byId = new Map();
    const byText = new Map();
    for (let j = start + 1; j < lines.length; j++) {
      const m = /^\[([xX ])\] (.*?)(?: \{#([A-Za-z0-9_.-]+)\})?\s*$/.exec(lines[j]);
      if (!m) break;
      const checked = m[1] !== ' ';
      if (m[3]) byId.set(m[3], checked);
      byText.set(singleLine(m[2]), checked);
    }
    return {patchset: msg._revision_number, byId, byText};
  }
  return null;
}

/**
 * Loads configuration and saved state of the checklist for the given change.
 * Returns {items: [{id, checkpoint, mandatory, label, threshold, checked}]}, or null if the
 * repository has no checklist. Throws ConfigError for an invalid checklist file.
 */
async function loadChecklist(plugin, change) {
  const [config, account, messages] = await Promise.all([
    loadConfig(plugin, change),
    plugin.restApi().getAccount(),
    change.messages
      ? Promise.resolve(change.messages)
      : plugin.restApi().get(`/changes/${change._number}/messages`),
  ]);
  if (!config) return null;

  const saved = account ? parseSavedState(messages || [], account._account_id) : null;
  const patchset = currentPatchsetNumber(change);
  const items = config.items.map(cp => {
    let checked = false;
    if (saved) {
      const text = singleLine(cp.checkpoint);
      checked = !!(cp.id && saved.byId.has(cp.id) ? saved.byId.get(cp.id) : saved.byText.get(text));
      if (
        checked &&
        cp.resetOnNewPatchset &&
        saved.patchset !== patchset &&
        !(saved.patchset < patchset && onlyTrivialPatchsets(change, saved.patchset, patchset))
      ) {
        checked = false;
      }
    }
    return {
      id: cp.id,
      checkpoint: cp.checkpoint,
      mandatory: cp.mandatory,
      label: cp.label,
      threshold: cp.threshold,
      checked,
    };
  });
  return {items};
}

/**
 * Highest vote on the label that the unchecked mandatory items still allow
 * (Infinity if not restricted).
 */
function maxAllowedVote(items, label) {
  return items
    .filter(i => i.mandatory && !i.checked && i.label === label)
    .reduce((max, i) => Math.min(max, i.threshold - 1), Infinity);
}

/** Labels restricted by mandatory items. */
function restrictedLabels(items) {
  return [...new Set(items.filter(i => i.mandatory).map(i => i.label))];
}

function voteText(label, value) {
  return `${label} ${formatLabelValue(value).trim()}`;
}

/** Searches an element by tag name, also inside shadow roots. */
function findDeep(root, tagName) {
  for (const el of root.querySelectorAll('*')) {
    if (el.tagName === tagName) return el;
    if (el.shadowRoot) {
      const found = findDeep(el.shadowRoot, tagName);
      if (found) return found;
    }
  }
  return null;
}

class ReviewChecklist extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.items = [];
    this.error = null;
    /** Downgrades shown in the banner: Map<label, {from, to}>. */
    this._downgrades = new Map();
    this.loaded = false;
    this._loadedKey = undefined;
  }

  // Set by Gerrit's endpoint decorator via <gr-endpoint-param name="change">.
  set change(change) {
    this._change = change;
    if (!change || !this.plugin) return;
    // Reload when switching changes, on new patch sets and on new messages.
    const key = `${change._number}/${currentPatchsetNumber(change)}/${(change.messages || []).length}`;
    if (key === this._loadedKey) return;
    this._loadedKey = key;
    this.load(change);
  }

  get change() {
    return this._change;
  }

  connectedCallback() {
    activeChecklist = this;
    if (this._change && this._loadedKey === undefined) this.change = this._change;
  }

  disconnectedCallback() {
    if (activeChecklist === this) activeChecklist = null;
  }

  async load(change) {
    this.loaded = false;
    let checklist = null;
    let error = null;
    try {
      checklist = await loadChecklist(this.plugin, change);
    } catch (err) {
      console.error('[reviewchecklist] failed to load checklist', err);
      if (err instanceof ConfigError) error = `Error in ${CHECKLIST_FILE}: ${err.message}`;
    }
    // Ignore results of an outdated request.
    if (this._change !== change) return;

    this.error = error;
    this.items = checklist ? checklist.items : [];
    this._downgrades = new Map();
    this.loaded = true;
    this.render();
  }

  restrictedLabels() {
    return restrictedLabels(this.items);
  }

  toStateMessage() {
    const lines = this.items.map(i => {
      const id = i.id ? ` {#${i.id}}` : '';
      return `[${i.checked ? 'X' : ' '}] ${singleLine(i.checkpoint)}${id}`;
    });
    return [MESSAGE_HEADER, ...lines].join('\n');
  }

  alert(message) {
    this.dispatchEvent(
      new CustomEvent('show-alert', {detail: {message, showDismiss: true}, bubbles: true, composed: true})
    );
  }

  /** Downgrades votes in the reply dialog that unchecked mandatory items do not allow. */
  enforceMandatory() {
    const replyApi = this.plugin.changeReply();
    let downgraded = false;
    for (const label of this.restrictedLabels()) {
      const max = maxAllowedVote(this.items, label);
      const value = labelValueAsNumber(replyApi.getLabelValue(label));
      if (value > max) {
        replyApi.setLabelValue(label, formatLabelValue(max));
        const previous = this._downgrades.get(label);
        this._downgrades.set(label, {from: previous ? Math.max(previous.from, value) : value, to: max});
        downgraded = true;
      }
    }
    this.updateWarning(downgraded);
  }

  /**
   * Shows a warning banner inside the checklist after a downgrade and highlights the
   * unchecked mandatory items that block the attempted votes, until they are checked.
   */
  updateWarning(downgraded) {
    const root = this.shadowRoot;
    const banner = root.querySelector('.warning');
    if (!banner) return;

    // Forget downgrades whose attempted vote is allowed again.
    for (const [label, d] of this._downgrades) {
      if (maxAllowedVote(this.items, label) >= d.from) this._downgrades.delete(label);
    }
    const blocking = this.items.filter(i => {
      const d = this._downgrades.get(i.label);
      return i.mandatory && !i.checked && d && i.threshold <= d.from;
    });
    this.items.forEach((item, index) => {
      const label = root.querySelector(`label[data-index="${index}"]`);
      if (label) label.classList.toggle('missing', blocking.includes(item));
    });

    const show = this._downgrades.size > 0;
    banner.hidden = !show;
    if (!show) return;
    const votes = [...this._downgrades].map(
      ([label, d]) => `${voteText(label, d.from)} was downgraded to ${formatLabelValue(d.to).trim()}`
    );
    banner.querySelector('.text').textContent =
      `${votes.join(', ')}: ${blocking.length} mandatory item(s) unchecked. ` +
      `Check the highlighted items and vote again.`;

    if (downgraded) {
      // Restart the shake animation and bring the banner into view.
      banner.classList.remove('flash');
      void banner.offsetWidth;
      banner.classList.add('flash');
      banner.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }
  }

  render() {
    const root = this.shadowRoot;
    root.innerHTML = '';
    if (this.items.length === 0 && !this.error) return;

    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; padding: var(--spacing-m, 8px) var(--spacing-xl, 16px); }
      .title { font-weight: var(--font-weight-bold, bold); margin-bottom: var(--spacing-s, 4px); }
      label { display: flex; align-items: flex-start; gap: var(--spacing-s, 4px); padding: 2px 0; cursor: pointer; }
      label .text { white-space: pre-line; }
      .mandatory { color: var(--error-text-color, #c5221f); font-weight: bold; }
      .requirement { color: var(--deemphasized-text-color, #666); white-space: nowrap; }
      .hint { color: var(--deemphasized-text-color, #666); font-style: italic; margin-top: var(--spacing-s, 4px); }
      label.missing { background: var(--error-background, #fce8e6); border-radius: 4px; padding-left: 4px; }
      .warning, .error {
        display: flex; align-items: flex-start; gap: var(--spacing-m, 8px);
        margin: var(--spacing-s, 4px) 0 var(--spacing-m, 8px);
        padding: var(--spacing-m, 8px) var(--spacing-l, 12px);
        border: 1px solid var(--error-foreground, #c5221f);
        border-left-width: 4px; border-radius: 4px;
        background: var(--error-background, #fce8e6);
        color: var(--primary-text-color, #202124);
      }
      .warning { font-weight: var(--font-weight-bold, bold); }
      .warning[hidden] { display: none; }
      .icon { color: var(--error-foreground, #c5221f); font-size: 1.2em; line-height: 1; }
      .warning.flash { animation: flash 0.4s ease-in-out 3; }
      @keyframes flash {
        0%, 100% { transform: translateX(0); }
        25% { transform: translateX(-4px); }
        75% { transform: translateX(4px); }
      }
      @media (prefers-reduced-motion: reduce) { .warning.flash { animation: none; } }
    `;
    root.appendChild(style);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = 'Review checklist';
    root.appendChild(title);

    if (this.error) {
      root.appendChild(this.createBox('error', this.error));
      return;
    }

    const banner = this.createBox('warning', '');
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    root.appendChild(banner);

    // Show the restricted vote per item only if the items restrict different votes.
    const requirements = new Set(this.items.filter(i => i.mandatory).map(i => voteText(i.label, i.threshold)));
    const showRequirement = requirements.size > 1;

    this.items.forEach((item, index) => {
      const label = document.createElement('label');
      label.dataset.index = String(index);
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = item.checked;
      box.addEventListener('change', () => {
        item.checked = box.checked;
        this.enforceMandatory();
      });
      label.appendChild(box);
      if (item.mandatory) {
        const star = document.createElement('span');
        star.className = 'mandatory';
        star.textContent = '*';
        label.appendChild(star);
      }
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = item.checkpoint;
      label.appendChild(text);
      if (item.mandatory && showRequirement) {
        const requirement = document.createElement('span');
        requirement.className = 'requirement';
        requirement.textContent = `(${voteText(item.label, item.threshold)})`;
        label.appendChild(requirement);
      }
      root.appendChild(label);
    });

    if (requirements.size > 0) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = showRequirement
        ? '* mandatory – required for the vote shown in brackets'
        : `* mandatory – required for ${[...requirements][0]}`;
      root.appendChild(hint);
    }

    this.updateWarning(false);
  }

  createBox(className, message) {
    const box = document.createElement('div');
    box.className = className;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '⚠';
    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = message;
    box.append(icon, text);
    return box;
  }
}

customElements.define(PLUGIN_ELEMENT, ReviewChecklist);

Gerrit.install(plugin => {
  plugin.registerCustomComponent('reply-text', PLUGIN_ELEMENT);

  // Live feedback while voting in the reply dialog.
  plugin.changeReply().addLabelValuesChangedCallback(({name}) => {
    const checklist = activeChecklist;
    if (checklist && checklist.restrictedLabels().includes(name)) {
      checklist.enforceMandatory();
    }
  });

  // Final check and persistence of the checklist state when the reply is sent.
  // Note: returning false here would leave the reply dialog disabled in Gerrit 3.14,
  // so the vote is downgraded instead of blocking the reply.
  plugin.on('before-reply-sent', (change, reviewInput) => {
    const checklist = activeChecklist;
    if (!checklist || checklist.items.length === 0) return true;
    if (!checklist.change || checklist.change._number !== change._number) return true;

    const reduced = [];
    for (const label of checklist.restrictedLabels()) {
      if (!reviewInput.labels || !(label in reviewInput.labels)) continue;
      const max = maxAllowedVote(checklist.items, label);
      const value = labelValueAsNumber(reviewInput.labels[label]);
      if (value > max) {
        reviewInput.labels[label] = max;
        reduced.push(`${voteText(label, value)} was reduced to ${formatLabelValue(max).trim()}`);
      }
    }
    if (reduced.length > 0) {
      checklist.alert(`${reduced.join(', ')}: mandatory checklist item(s) unchecked.`);
    }

    const state = checklist.toStateMessage();
    reviewInput.message = reviewInput.message ? `${reviewInput.message}\n\n${state}` : state;
    return true;
  });

  // --- Quick approve -------------------------------------------------------------------
  // Gerrit offers two shortcuts that vote without the reply dialog: the "Code-Review+2"
  // action button and the "Vote Code-Review +2" button in the submit requirement hovercard.
  // If mandatory items are unchecked, both are redirected to the reply dialog instead.

  /** Checklist state of the displayed change: {changeNum, promise, result}. */
  let guard = null;

  plugin.on('showchange', change => {
    const entry = {changeNum: change._number, result: undefined};
    entry.promise = loadChecklist(plugin, change)
      .catch(() => null)
      .then(result => (entry.result = result));
    guard = entry;
  });

  /**
   * Decides whether a quick vote must be blocked.
   * Returns true (block), false (allow) or undefined (state not loaded yet).
   */
  function mustBlock(label, value) {
    if (!guard || guard.result === undefined) return undefined;
    const checklist = guard.result;
    if (!checklist) return false;
    return value > maxAllowedVote(checklist.items, label);
  }

  /** Opens the reply dialog with the attempted vote, which then shows the warning banner. */
  async function redirectToReplyDialog(label, value) {
    const changeView = findDeep(document, 'GR-CHANGE-VIEW');
    if (!changeView) return;
    changeView.dispatchEvent(new CustomEvent('open-reply-dialog'));
    const changeNum = guard && guard.changeNum;
    for (let i = 0; i < 50; i++) {
      const checklist = activeChecklist;
      if (checklist && checklist.loaded && checklist.change && checklist.change._number === changeNum) {
        if (checklist.items.length === 0) return;
        plugin.changeReply().setLabelValue(label, formatLabelValue(value));
        checklist.enforceMandatory();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  // Quick approve action button (action key "review", labelled e.g. "Code-Review+2").
  plugin.on('before-change-action', async key => {
    if (key !== 'review' || !guard) return true;
    const button = findDeep(document, 'GR-CHANGE-ACTIONS');
    const actionButton =
      button && button.shadowRoot && button.shadowRoot.querySelector('[data-action-key="review"]');
    const m = actionButton && /^(.+?)\+(\d+)$/.exec(actionButton.textContent.trim());
    if (!m) return true;
    await guard.promise;
    if (!mustBlock(m[1], Number(m[2]))) return true;
    redirectToReplyDialog(m[1], Number(m[2]));
    return false;
  });

  // Vote button in the submit requirement hovercard. It calls the REST API directly, so the
  // click is intercepted in the capture phase before it reaches the button.
  window.addEventListener(
    'click',
    e => {
      const button = e.composedPath().find(n => n.classList && n.classList.contains('quickApprove'));
      if (!button) return;
      const m = /^Vote (.+) \+(\d+)$/.exec(button.textContent.trim());
      if (!m) return;
      const blocked = mustBlock(m[1], Number(m[2]));
      if (blocked === false) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      // State not loaded yet: the reply dialog is always a safe fallback.
      redirectToReplyDialog(m[1], Number(m[2]));
    },
    true
  );
});
})();
