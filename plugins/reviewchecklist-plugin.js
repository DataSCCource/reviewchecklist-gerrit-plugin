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
<dom-module>
    <template is="dom-if" if="[[checklistPoints.length]]">
        <hr style="height:1px;border:none;background-color:#BBB"/>
        <div style="font-weight:bold;">Review Checklist:</div>

        <template is="dom-repeat" items="[[checklistPoints]]">
            <label>
            <input type="checkbox" name="checkboxgroup" checked$="{{item.checked}}">
            <template is="dom-if" if="[[item.mandatory]]"><b>*</b></template>[[item.checkpoint]]
            </label>
            <br />
        </template>
        <template is="dom-if" if="[[mandatoryCheckpointExists]]"><b>*</b> - <i>Checkpoint is mandatory</i></template>

    </template>
</dom-module>
`;

const cpList = [];

class ReviewChecklist extends Polymer.Element {
    static get is() { return pluginName; }
    static get template() { return checklistTemplate; }
    static get properties() {
        return {
            checklistPoints: {
                type: Array,
                value() {
                    return []
                }
            },
            mandatoryCheckpointExists: Boolean,
        };
    }
    constructor() {
        super();

        // TODO: read list from json-file
        cpList.push({checkpoint: "Checkpoint 1", mandatory: true});
        cpList.push({checkpoint: "Checkpoint 2", mandatory: false});
        cpList.push({checkpoint: "Checkpoint 3"});

        for(var i=0; i<cpList.length; i++) {
            this.checklistPoints.push({checkpoint: cpList[i].checkpoint, mandatory: cpList[i].mandatory, checked: false});
            if(cpList[i].mandatory == true) this.mandatoryCheckpointExists = true;
        }
    }
}

customElements.define(ReviewChecklist.is, ReviewChecklist);

Gerrit.install(plugin => {
    plugin.registerCustomComponent('reply-text', pluginName).onAttached(changeElement => {
    });
});
