/**
 * Review checklist plugin for Gerrit
 *
 * Adds a checklist to the changeview of a gerrit change for configured repositories.
 * Only works with Gerrit 3.4 right now!
 *
 * @link https://github.com/DataSCCource/reviewchecklist-gerrit-plugin
 * @version 0.2 (work-in-progress)
 * @author Dennis W. (DataSCCource)
 * @since January 2022
 *
 * @usage Copy .js file to plugins folder of your Gerrit installation and wait a minute.
 *        Add .review-checklist.json file to your repository with the following format:
 *          [
 *              {"checkpoint": "Checkpoint 1 (mandatory)", "mandatory": true, "resetOnNewPatchset": true},
 *              {"checkpoint": "Checkpoint 2 (not mandatory)", "mandatory": false},
 *              {"checkpoint": "Checkpoint 3 (not mandatory)"}
 *          ]
 *        'checkpoint' - string of a checklist item
 *        'mandatory' is optional - can be true, false or omitted; prevents Code-Review +2
 *        'resetOnNewPatchset' is optional - can be true, false or omitted
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
            <input type="checkbox" name="checkboxgroup" checked="{{item.checked::change}}" onchange="checkboxClicked(this)" data-mandatory="[[item.mandatory]]" />
            <template is="dom-if" if="[[item.mandatory]]"><b>*</b></template>[[item.checkpoint]]
            </label>
            <br />
        </template>
        <template is="dom-if" if="[[mandatoryCheckpointExists]]"><b>*</b> - <i>Checkpoint is mandatory</i></template>

    </template>
</dom-module>
`;

var hookElement;
var replyApi;

function checkboxClicked(checkbox) {
    if(!checkbox.checked && checkbox.dataMandatory) {
        evaluateCodeReviewLabel("Code-Review", true);
    }
}

function evaluateCodeReviewLabel(name, uncheckedMandatory) {
    if(hookElement.checkpointsExists) {
        // search for unchecked mandatory list item
        var uncheckedMandatoryItems = uncheckedMandatory?1:0;
        for (let i = 0; i < hookElement.checklistPoints.length; i++) {
            if(!hookElement.checklistPoints[i].checked && hookElement.checklistPoints[i].mandatory) {
                uncheckedMandatoryItems++;
            }
        }

        if (replyApi.getLabelValue('Code-Review') === '+2' && uncheckedMandatoryItems != 0) {
            replyApi.setLabelValue('Code-Review', '+1');

            // message below review labels
            replyApi.showMessage('ATTENTION: mandatory checkpoints need to be checked, to set +2 on Code-Review label!');

            // show toast notification
            var toast = document.createElement('gr-alert');
            toast.show(`${uncheckedMandatory?"Code-Review label was downgraded to \"+1\".":"You cannot vote \"+2\" for Code-Review label!"} ${uncheckedMandatoryItems} mandatory checklist item(s) still unchecked.`);
            setTimeout(function() {toast.hide();}, 3000);
        } else if (name === 'Code-Review') {
            replyApi.showMessage('');
        }
    }
}

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

    plugin.registerCustomComponent(pluginHook, pluginName).onAttached(changeElement => {
        // "save" element-reference for later use
        hookElement = changeElement;
        const repoName = changeElement.plugin.report.reportRepoName;

        const filePath = `/plugins/gitiles/${repoName}/+/refs/heads/master/${fileName}?format=text`;
        var cpList = [];
        var cpStatus = [];

        fetch(filePath)
        .then(response=>response.text())
        .then(data => {
            if (data && data !== '') {
                const urlArray = JSON.parse(atob(data));

                urlArray.forEach(function(checkpoint) {
                    cpList.push({checkpoint: checkpoint.checkpoint, mandatory: checkpoint.mandatory, resetOnNewPatchset: checkpoint.resetOnNewPatchset});
                });
                console.log(`# Review Checklist loaded from repository with ${cpList.length} item(s)`);
            }
        })
        .catch(()=> {
            console.log(`# Review Checklist: No existing ${fileName}, using default... `);

            /* Default checklist; uncomment and fill the following lines if you want a default */
            //cpList = [
            //    {checkpoint: "Checkpoint 1", mandatory: true, resetOnNewPatchset: true},
            //    {checkpoint: "Checkpoint 2", mandatory: false},
            //    {checkpoint: "Checkpoint 3"}
            //];
            fillChecklist(cpList, cpStatus);
        });

        plugin.restApi().get('/accounts/self').then(accountInfo => {
            // save _account_id
            plugin.report.accountId = accountInfo._account_id
        });

        plugin.restApi().get(`/changes/${plugin.report.reportChangeId}?o=CURRENT_REVISION&o=MESSAGES`).then(changeInfo => {
            // save current_revision id
            plugin.report.revisionId = changeInfo.current_revision;
            // save revision number, which is the first (and only) revision in the changeInfo, since "CURRENT_REVISION" was requested
            plugin.report.revisionNumber = changeInfo.revisions[Object.keys(changeInfo.revisions)[0]]._number;

            // get status of checklistpoints
            for (let i = changeInfo.messages.length-1; i >= 0; i--) {
                const messageArray = changeInfo.messages[i].message.split("\n");
                const authorId = changeInfo.messages[i].author._account_id;
                if(authorId == plugin.report.accountId && messageArray[2] == "Checklist:") {
                    for (let j = 3; j < messageArray.length; j++) {
                        var checked = (messageArray[j].substring(1,2)=="X");
                        var differentPatchset = (plugin.report.revisionNumber != changeInfo.messages[i]._revision_number);
                        cpStatus.push({checkpoint: messageArray[j].substring(4), checked: (checked?true:false), differentPatchset: differentPatchset });
                    }

                    break;
                }
            }
            fillChecklist(cpList, cpStatus);
        });

        // TODO: Find other way. This only works in Gerrit 3.4.
        const sendButton = hookElement.parentNode.host.parentNode.parentNode.querySelector(".stickyBottom").querySelector(".actions").querySelector(".right").querySelector("#sendButton").root.querySelector("paper-button");
        sendButton.addEventListener("click", () => {
            var checklistString = "Checklist:";
            for (let i = 0; i < hookElement.checklistPoints.length; i++) {
                checklistString += `\n[${hookElement.checklistPoints[i].checked?"X":" "}] `
                                + hookElement.checklistPoints[i].checkpoint;
            }

            const reviewInput = `{"message": "${checklistString}", "notify": "NONE"}`;
            plugin.restApi().post(`/changes/${plugin.report.reportChangeId}/revisions/${plugin.report.revisionId}/review`, reviewInput);
        });
    });

    function fillChecklist(checklistArray, checklistStatus) {
        hookElement.checklistPoints = [];
        hookElement.checkpointsExists = false;
        hookElement.mandatoryCheckpointExists = false;

        for(var i=0; i<checklistArray.length; i++) {
            hookElement.checkpointsExists = true;
            var checked = checklistStatus[i] && checklistStatus[i].checked && !(checklistArray[i].resetOnNewPatchset && checklistStatus[i].differentPatchset);
            hookElement.checklistPoints.push({checkpoint: checklistArray[i].checkpoint, mandatory: checklistArray[i].mandatory, checked: checked});
            if(checklistArray[i].mandatory == true) hookElement.mandatoryCheckpointExists = true;
        }
    }

    // prevent +2 Code-Review label if mandatory checklistpoint is not checked
    replyApi = plugin.changeReply();
    replyApi.addLabelValuesChangedCallback(({name, value}) => {
        evaluateCodeReviewLabel(name, false);
    });
});
