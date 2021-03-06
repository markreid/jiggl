const _ = require('lodash');
const Sequelize = require('sequelize');

const {
  models,
  distinct,
  removeTogglEntriesBetween,
  getTogglEntriesWithIssueKey,
  updateTogglEntryIssue,
  flagEntriesWithBadIssueKey,
  createJiraIssue,
  getJiraIssuesWithUnlinkedEpics,
  getJiraIssuesWithUnlinkedParents,
  updateJiraIssueParent,
  updateJiraIssueEpic,
  updateJiraIssuesFromRelatedIssue,
} = require('../db');
const {
  getTogglDetailedReport,
  saveReportItems,
} = require('./toggl');
const {
  dateToUtc,
  sequential,
} = require('./util');
const {
  getIssueFromServer,
} = require('./jira');


// remove, fetch and save toggl entries for a date range
const pullTogglEntries = async (togglDateObject) => {
  const { since, until } = togglDateObject;
  await removeTogglEntriesBetween(dateToUtc(since), dateToUtc(until));
  const report = await getTogglDetailedReport(togglDateObject);
  return saveReportItems(report);
};


// fetch jira issues for all toggl entries that aren't yet
// associated with an issue.
const pullJiraIssues = async () => {
  // get the issue keys.
  // for each, hit the API
  // create the issue
  // link the togglentry back to the issue
  const entries = await getTogglEntriesWithIssueKey();
  const groupedByKey = _.groupBy(entries, e => e.issueKey);
  const issueKeys = Object.keys(groupedByKey);

  // fetch 10 at a time from the server
  const chunkedIssueKeys = _.chunk(issueKeys, 10);

  const issues = await sequential(chunkedIssueKeys, async keys => {
    return Promise.all(keys.map(getIssueFromServer));
  });

  await sequential(issues, async (issue) => {
    if (issue) {
      return createJiraIssue(issue);
    }
    return false;
  });

  await Promise.all(
    issueKeys.map((issueKey, i) => {
      const entryIds = groupedByKey[issueKey].map(entry => entry.id);
      if (issues[i]) {
        return updateTogglEntryIssue(entryIds, issues[i].id);
      }
      return flagEntriesWithBadIssueKey(entryIds);
    }),
  );
}

/**
 * Find all JiraIssues that have an epicKey but no epicId,
 * pull the epics from the server, create them locally
 * and associate them with the issues.
 */
const pullJiraEpics = async () => {
  const issues = await getJiraIssuesWithUnlinkedEpics();
  const groupedByKey = _.groupBy(issues, i => i.epicKey);
  const epicKeys = Object.keys(groupedByKey);

  const chunkedEpicKeys = _.chunk(epicKeys, 10);

  const epics = await sequential(chunkedEpicKeys, async keys => {
    return Promise.all(keys.map(getIssueFromServer));
  });

  await sequential(epics, async epic => {
    // todo - what to do here? see above in pullJiraIssues()
    if (!epic) return false;

    return createJiraIssue(epic);
  });

  await Promise.all(
    epicKeys.map((epicKey, i) => {
      if (epics[i]) {
        const issueIds = groupedByKey[epicKey].map(issue => issue.id);
        return updateJiraIssueEpic(issueIds, epics[i].id);
      }
    }),
  );
};


/**
 * Find all JiraIssues that have a parentKey but no parentId,
 * pull the parents from the server, create them locally
 * and associate them with the child issues.
 */
const pullJiraParents = async () => {
  const issues = await getJiraIssuesWithUnlinkedParents();
  const groupedByKey = _.groupBy(issues, i => i.parentKey);
  const parentKeys = Object.keys(groupedByKey);

  const chunkedParentKeys = _.chunk(parentKeys, 10);

  const parents = await sequential(chunkedParentKeys, async keys => Promise.all(keys.map(getIssueFromServer)));

  await sequential(parents, async parent => {
    if (!parent) return false;
    return createJiraIssue(parent);
  });

  await Promise.all(
    parentKeys.map((parentKey, i) => {
      if (parents[i]) {
        const issueIds = groupedByKey[parentKey].map(issue => issue.id);
        return updateJiraIssueParent(issueIds, parents[i].id);
      }
    }),
  );
}


/**
 * Find all issues with a Parent or an Epic,
 * and set some properties of the parents/epics on the children (ie, isRoadmapItem)
 * Epics take precedence.
 */
const updatePropertiesFromParentsAndEpics = async () => {
  // get parents
  const parentIds = (await distinct(models.JiraIssue, 'parentId')).filter(Boolean);
  const parents = await models.JiraIssue.findAll({
    where: {
      id: {
        [Sequelize.Op.in]: parentIds,
      },
    },
  });

  // update the children
  parents.forEach(async (parent) => {
    await updateJiraIssuesFromRelatedIssue({
      parentId: parent.get('id'),
    }, parent);
  });


  // get epics
  const epicIds = (await distinct(models.JiraIssue, 'epicId')).filter(Boolean);
  const epics = await models.JiraIssue.findAll({
    where: {
      id: {
        [Sequelize.Op.in]: epicIds,
      },
    },
  });

  // update the children
  epics.forEach(async (epic) => {
    await updateJiraIssuesFromRelatedIssue({
      epicId: epic.get('id'),
    }, epic)
  });
}



module.exports = {
  pullTogglEntries,
  pullJiraIssues,
  pullJiraEpics,
  pullJiraParents,
  updatePropertiesFromParentsAndEpics,
};
