/**
 * Review checklist plugin for Gerrit
 *
 * Adds a checklist to the reply dialog of a Gerrit change for configured repositories.
 * Tested with Gerrit 3.14.
 *
 * @link https://github.com/DataSCCource/reviewchecklist-gerrit-plugin
 * @version 0.3
 * @author Dennis W. (DataSCCource)
 * @since January 2022
 *
 * @usage Copy .js file to the plugins folder of your Gerrit installation and wait a minute.
 *        Add a .review-checklist.json file to the target branch of your repository:
 *          [
 *              {"checkpoint": "Checkpoint 1 (mandatory)", "mandatory": true, "resetOnNewPatchset": true},
 *              {"checkpoint": "Checkpoint 2 (not mandatory)", "mandatory": false},
 *              {"checkpoint": "Checkpoint 3 (not mandatory)"}
 *          ]
 *        'checkpoint'         - text of a checklist item
 *        'mandatory'          - optional; unchecked mandatory items prevent Code-Review +2
 *        'resetOnNewPatchset' - optional; item is unchecked again when a new patch set is uploaded
 *
 *        The state of the checklist is stored in the review message of each reply.
 *        Note: the +2 restriction is enforced in the web UI only, not on the server.
 */

const PLUGIN_ELEMENT = 'reviewchecklist-plugin';
const CHECKLIST_FILE = '.review-checklist.json';
const CODE_REVIEW = 'Code-Review';
const MESSAGE_HEADER = 'Review checklist:';
// Header written by version 0.2 of this plugin, still understood when reading.
const LEGACY_MESSAGE_HEADER = 'Checklist:';

/** The checklist element of the currently open reply dialog. */
let activeChecklist = null;

function labelValueAsNumber(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(String(value).trim().replace('+', ''));
  return Number.isNaN(n) ? 0 : n;
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

/**
 * Finds the checklist state stored in the latest review message of the given account.
 * Returns {patchset, states: Map<checkpointText, boolean>} or null.
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
    const states = new Map();
    for (let j = start + 1; j < lines.length; j++) {
      const m = /^\[([xX ])\] (.*)$/.exec(lines[j]);
      if (!m) break;
      states.set(m[2].trim(), m[1] !== ' ');
    }
    return {patchset: msg._revision_number, states};
  }
  return null;
}

class ReviewChecklist extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode: 'open'});
    this.items = [];
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
    try {
      const [config, account, messages] = await Promise.all([
        this.loadConfig(change),
        this.plugin.restApi().getAccount(),
        change.messages
          ? Promise.resolve(change.messages)
          : this.plugin.restApi().get(`/changes/${change._number}/messages`),
      ]);
      // Ignore results of an outdated request.
      if (this._change !== change) return;

      const saved = account ? parseSavedState(messages || [], account._account_id) : null;
      const patchset = currentPatchsetNumber(change);
      this.items = config.map(cp => {
        let checked = !!(saved && saved.states.get(cp.checkpoint));
        if (checked && cp.resetOnNewPatchset && saved.patchset !== patchset) checked = false;
        return {checkpoint: cp.checkpoint, mandatory: !!cp.mandatory, checked};
      });
      this._downgraded = false;
      this.render();
    } catch (err) {
      console.error('[reviewchecklist] failed to load checklist', err);
      this.items = [];
      this.render();
    }
  }

  async loadConfig(change) {
    const url =
      `/projects/${encodeURIComponent(change.project)}` +
      `/branches/${encodeURIComponent(change.branch)}` +
      `/files/${encodeURIComponent(CHECKLIST_FILE)}/content`;
    // errFn suppresses Gerrit's error dialog when the file does not exist.
    const response = await this.plugin.restApi().fetch('GET', url, undefined, () => {});
    if (!response || !response.ok) return [];
    const parsed = JSON.parse(decodeBase64Utf8(await response.text()));
    if (!Array.isArray(parsed)) throw new Error(`${CHECKLIST_FILE} must contain a JSON array`);
    return parsed.filter(cp => cp && typeof cp.checkpoint === 'string' && cp.checkpoint.trim());
  }

  uncheckedMandatoryCount() {
    return this.items.filter(i => i.mandatory && !i.checked).length;
  }

  toStateMessage() {
    return [MESSAGE_HEADER, ...this.items.map(i => `[${i.checked ? 'X' : ' '}] ${i.checkpoint}`)].join('\n');
  }

  alert(message) {
    this.dispatchEvent(
      new CustomEvent('show-alert', {detail: {message, showDismiss: true}, bubbles: true, composed: true})
    );
  }

  /** Downgrades Code-Review +2 to +1 in the reply dialog if mandatory items are unchecked. */
  enforceMandatory() {
    const unchecked = this.uncheckedMandatoryCount();
    const replyApi = this.plugin.changeReply();
    const downgraded = unchecked > 0 && labelValueAsNumber(replyApi.getLabelValue(CODE_REVIEW)) === 2;
    if (downgraded) replyApi.setLabelValue(CODE_REVIEW, '+1');
    this.updateWarning(downgraded);
  }

  /**
   * Shows a warning banner inside the checklist after a downgrade and highlights the
   * unchecked mandatory items, until all of them are checked.
   */
  updateWarning(downgraded) {
    const root = this.shadowRoot;
    const banner = root.querySelector('.warning');
    if (!banner) return;

    const unchecked = this.uncheckedMandatoryCount();
    if (downgraded) this._downgraded = true;
    if (unchecked === 0) this._downgraded = false;
    const show = !!this._downgraded;

    for (const label of root.querySelectorAll('label[data-mandatory]')) {
      label.classList.toggle('missing', show && !label.querySelector('input').checked);
    }

    banner.hidden = !show;
    if (!show) return;
    banner.querySelector('.text').textContent =
      `${CODE_REVIEW} +2 was downgraded to +1: ${unchecked} mandatory item(s) unchecked. ` +
      `Check the highlighted items and vote +2 again.`;

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
    if (this.items.length === 0) return;

    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; padding: var(--spacing-m, 8px) var(--spacing-xl, 16px); }
      .title { font-weight: var(--font-weight-bold, bold); margin-bottom: var(--spacing-s, 4px); }
      label { display: flex; align-items: center; gap: var(--spacing-s, 4px); padding: 2px 0; cursor: pointer; }
      .mandatory { color: var(--error-text-color, #c5221f); font-weight: bold; }
      .hint { color: var(--deemphasized-text-color, #666); font-style: italic; margin-top: var(--spacing-s, 4px); }
      label.missing { background: var(--error-background, #fce8e6); border-radius: 4px; padding-left: 4px; }
      .warning {
        display: flex; align-items: flex-start; gap: var(--spacing-m, 8px);
        margin: var(--spacing-s, 4px) 0 var(--spacing-m, 8px);
        padding: var(--spacing-m, 8px) var(--spacing-l, 12px);
        border: 1px solid var(--error-foreground, #c5221f);
        border-left-width: 4px; border-radius: 4px;
        background: var(--error-background, #fce8e6);
        color: var(--primary-text-color, #202124);
        font-weight: var(--font-weight-bold, bold);
      }
      .warning[hidden] { display: none; }
      .warning .icon { color: var(--error-foreground, #c5221f); font-size: 1.2em; line-height: 1; }
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

    const banner = document.createElement('div');
    banner.className = 'warning';
    banner.setAttribute('role', 'alert');
    banner.hidden = true;
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.textContent = '⚠';
    const bannerText = document.createElement('span');
    bannerText.className = 'text';
    banner.append(icon, bannerText);
    root.appendChild(banner);

    for (const item of this.items) {
      const label = document.createElement('label');
      if (item.mandatory) label.dataset.mandatory = '';
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
      text.textContent = item.checkpoint;
      label.appendChild(text);
      root.appendChild(label);
    }

    if (this.items.some(i => i.mandatory)) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = `* mandatory – required for ${CODE_REVIEW} +2`;
      root.appendChild(hint);
    }

    this.updateWarning(false);
  }
}

customElements.define(PLUGIN_ELEMENT, ReviewChecklist);

Gerrit.install(plugin => {
  plugin.registerCustomComponent('reply-text', PLUGIN_ELEMENT);

  // Live feedback while voting in the reply dialog.
  plugin.changeReply().addLabelValuesChangedCallback(({name}) => {
    if (name === CODE_REVIEW && activeChecklist && activeChecklist.items.length > 0) {
      activeChecklist.enforceMandatory();
    }
  });

  // Final check and persistence of the checklist state when the reply is sent.
  // Note: returning false here would leave the reply dialog disabled in Gerrit 3.14,
  // so the vote is downgraded instead of blocking the reply.
  plugin.on('before-reply-sent', (change, reviewInput) => {
    const checklist = activeChecklist;
    if (!checklist || checklist.items.length === 0) return true;
    if (!checklist.change || checklist.change._number !== change._number) return true;

    const unchecked = checklist.uncheckedMandatoryCount();
    if (unchecked > 0 && reviewInput.labels && labelValueAsNumber(reviewInput.labels[CODE_REVIEW]) === 2) {
      reviewInput.labels[CODE_REVIEW] = 1;
      checklist.alert(`${CODE_REVIEW} +2 was reduced to +1: ${unchecked} mandatory checklist item(s) unchecked.`);
    }

    const state = checklist.toStateMessage();
    reviewInput.message = reviewInput.message ? `${reviewInput.message}\n\n${state}` : state;
    return true;
  });
});
