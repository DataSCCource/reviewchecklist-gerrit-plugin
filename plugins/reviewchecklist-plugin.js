/**
 * Review checklist plugin for Gerrit
 *
 * Adds a checklist to the changeview of a gerrit change for configured repositories.
 *
 * @link https://github.com/DataSCCource/reviewchecklist-gerrit-plugin
 * @version 0.1 (work-in-progress)
 * @author Dennis W. (DataSCCource)
 * @since January 2022
 *
 * @usage Copy .js file to plugins folder of your Gerrit installation and wait a minute
 */

const pluginName = "reviewchecklist-plugin";

const checklistTemplate = Polymer.html`
<hr />
<div>
    <div style="font-weight:bold">Review Checklist:</div>
    <input type="checkbox" name="checkboxgroup" id="cb1"> <label for="cb1">Checkpoint 1</label> <br />
    <input type="checkbox" name="checkboxgroup" id="cb2"> <label for="cb2">Checkpoint 2</label> <br />
    <input type="checkbox" name="checkboxgroup" id="cb3"> <label for="cb3">Checkpoint 3</label> <br />
</div>
`;

class ReviewChecklist extends Polymer.Element {
    static get is() { return pluginName; }
    static get template() { return checklistTemplate; }
}

customElements.define(ReviewChecklist.is, ReviewChecklist);

Gerrit.install(plugin => {
    plugin.registerCustomComponent('reply-text', pluginName, {replace: false}).onAttached(changeElement => {
    });
});
