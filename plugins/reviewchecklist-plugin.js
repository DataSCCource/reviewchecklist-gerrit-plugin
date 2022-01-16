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
 * @usage Copy .js file to plugins folder of your Gerrit installation and wait a minute.
 *        Add .review-checklist.json file to your repository with the following format:
 *          [
 *              {"checkpoint": "Checkpoint 1 (mandatory)", "mandatory": true},
 *              {"checkpoint": "Checkpoint 2 (not mandatory)", "mandatory": false},
 *              {"checkpoint": "Checkpoint 3 (not mandatory)"}
 *          ]
 *        'checkpoint' - string of a checklist item
 *        'mandatory' is optional - can be true, false or omitted
 * @requires gitiles plugin to get access to the .review-checklist.json file containing the repo specific checklist.
 */

const pluginName = 'reviewchecklist-plugin';
const pluginHook = 'reply-text';
const fileName = '.review-checklist.json';

const checklistTemplate = Polymer.html`
<dom-module>
    <template is="dom-if" if="[[checkpointsExists]]">
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
            checkpointsExists: Boolean,
            mandatoryCheckpointExists: Boolean,
        };
    }
}

customElements.define(ReviewChecklist.is, ReviewChecklist);

Gerrit.install(plugin => {
    var hookElement;

    plugin.registerCustomComponent(pluginHook, pluginName).onAttached(changeElement => {
        // "save" element-reference for later use
        hookElement = changeElement;
        const repoName = changeElement.plugin.report.reportRepoName;

        const filePath = `/plugins/gitiles/${repoName}/+/refs/heads/master/${fileName}?format=text`;
        var cpList = [];

        fetch(filePath)
        .then(response=>response.text())
        .then(data => {
            if (data && data !== '') {
                const urlArray = JSON.parse(atob(data));

                urlArray.forEach(function(checkpoint) {
                    cpList.push({checkpoint: checkpoint.checkpoint, mandatory: checkpoint.mandatory});
                });
                fillChecklist(cpList);
            }
        })
        .catch(()=> {
            console.log(`# Review Checklist: No existing ${fileName}, using default... `);

            /* Default checklist; uncomment and fill the following lines if you want a default */
            //cpList = [
            //    {checkpoint: "Checkpoint 1", mandatory: true},
            //    {checkpoint: "Checkpoint 2", mandatory: false},
            //    {checkpoint: "Checkpoint 3"}
            //];
            fillChecklist(cpList);
        });
    });

    function fillChecklist(checklistArray) {
        hookElement.checklistPoints = [];
        hookElement.checkpointsExists = false;
        hookElement.mandatoryCheckpointExists = false;

        for(var i=0; i<checklistArray.length; i++) {
            hookElement.checkpointsExists = true;
            hookElement.checklistPoints.push({checkpoint: checklistArray[i].checkpoint, mandatory: checklistArray[i].mandatory, checked: false});
            if(checklistArray[i].mandatory == true) hookElement.mandatoryCheckpointExists = true;
        }
    }
});
