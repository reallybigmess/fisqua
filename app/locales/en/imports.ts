/**
 * English translations — imports namespace
 *
 * This locale namespace carries the English strings for the whole imports
 * module surface at `/admin/imports`: upload intake and the staged-uploads
 * list, the starter-profile pick and the mapping-profile create / edit /
 * view surfaces, the dry-run report and its rejects table, the commit act,
 * the run list and run detail, and the revert action.
 *
 * @version v0.6.0
 */
export default {
  title: "Imports",
  intro:
    "Bring catalogue records into this workspace from a spreadsheet. Four steps: upload a CSV, check it against a mapping profile, review the dry run, and commit as a reversible import.",

  busy: {
    dryRun: "Running dry run…",
    commit: "Committing…",
    upload: "Uploading…",
    revert: "Reverting…",
  },

  nav: {
    back: "Back to imports",
    breadcrumb: "Breadcrumb",
    uploads: "Uploads",
    profiles: "Mapping profiles",
  },

  upload: {
    help: "Export your records as a CSV in UTF-8. Only UTF-8 files are accepted; anything else is rejected by name so nothing is silently corrupted.",
    fileLabel: "CSV file",
    stagingNote:
      "Your file is uploaded and held for checking — nothing touches the catalogue until the Import step. The file you upload, and the reports the check produces from it, are kept within your workspace.",
  },

  uploads: {
    colFile: "File",
    colRows: "Rows",
    colSize: "Size",
    colStatus: "Status",
    colStaged: "Staged",
    colActions: "Actions",
    view: "View",
    status: {
      staged: "Staged",
      committed: "Committed",
      discarded: "Discarded",
    },
  },

  profiles: {
    heading: "Mapping profiles",
    intro: "A profile maps your spreadsheet's columns to description fields. Profiles belong to this workspace and are versioned.",
    empty: "No profiles yet. Create one to map your columns.",
    sharedEmpty: "No profiles are shared with this workspace.",
    ownHeading: "This workspace",
    sharedHeading: "Shared with this workspace",
    create: "Create a profile",
    edit: "Edit",
    view: "View",
    sharedBadge: "Shared · read-only",
    starterBadge: "Starter",
    version: "v{{version}}",
  },

  starters: {
    heading: "Start from a format you already have",
    intro:
      "If your records are already in a common export format, start from a predefined mapping and adjust it. Picking one opens it in the editor so you can review it before your first import.",
    use: "Use this starter",
    templateIntro:
      "Starting a catalogue from nothing? Download the Fisqua template — its columns already match this workspace's descriptive standard.",
    templateDownload: "Download the Fisqua template",
    fromScratch: {
      name: "Start from scratch",
      desc: "Map your columns by hand — for a format none of the starters cover.",
      action: "Build a profile",
    },
    atomIsadg: {
      name: "AtoM ISAD(G) CSV",
      desc: "The ISAD(G) CSV that AtoM exports and imports, column for column, with pipe-separated values.",
    },
    agnFuid: {
      name: "AGN FUID (documentary inventory)",
      desc: "Colombia's Formato Único de Inventario Documental — the inventory-control format most Colombian archives keep.",
    },
    eap: {
      name: "EAP catalogue listing",
      desc: "The Endangered Archives Programme (British Library) listing template — multilevel ISAD(G) description.",
    },
    meap: {
      name: "MEAP metadata (item-level)",
      desc: "The Modern Endangered Archives Program (UCLA) template — one row per digitized object, no hierarchy.",
    },
    canonical: {
      name: "Fisqua template",
      desc: "This workspace's own template, generated from its descriptive standard — the fastest path for a fresh catalogue.",
    },
    errors: {
      duplicate_name:
        "You already have a profile with this starter's name. <profile>Rename the existing one</profile>, then pick the starter again.",
      not_offered:
        "That starter is not available for this workspace's descriptive standard.",
      invalid_bindings: "This starter could not be prepared. Try again.",
    },
  },

  profileEditor: {
    createHeading: "Create a mapping profile",
    editHeading: "Edit mapping profile",
    viewHeading: "Mapping profile",
    name: "Profile name",
    namePlaceholder: "e.g. AtoM ISAD(G) CSV",
    sharedToggle: "Share with member workspaces",
    sharedHelp: "When shared, member workspaces in this federation can use this profile read-only.",
    bindingsHeading: "Column mapping",
    bindingsHelp: "Map each source column, by header name, to a description field. Add a transform where the value needs reshaping.",
    sourceHeader: "Source column (header name)",
    targetField: "Description field",
    transform: "Transform",
    chooseTarget: "Choose a field",
    addBinding: "Add a mapping",
    removeBinding: "Remove",
    save: "Save profile",
    delete: "Delete profile",
    deleteConfirm: "Delete this profile? Uploads and runs that referenced it keep working; only the profile is removed.",
    cancel: "Cancel",
    readOnlyNote: "This profile is shared from the federation lead and cannot be edited here.",
    availableHeaders: "Columns detected in the upload",
    transformKind: {
      none: "Direct copy",
      direct: "Direct copy",
      defaultWhenBlank: "Default when blank",
      constant: "Constant value",
      concatenate: "Concatenate columns",
      splitRejoin: "Split and rejoin",
      date: "Parse date",
      vocabulary: "Remap vocabulary",
      carryForward: "Carry forward",
    },
    errors: {
      invalid_bindings: "The mapping has problems. Fix the highlighted items and save again.",
      at_least_one_binding: "Add at least one column mapping.",
      duplicate_target: "Two mappings target the same field. Each field can be mapped once.",
      reference_code_binding_required: "Map a source column to the reference code — rows are matched by it.",
      invalid_target: "A mapped field is not available for this workspace's descriptive standard.",
      name_required: "Give the profile a name.",
      duplicate_name:
        "A profile with that name already exists in this workspace. <profile>Open the existing profile</profile> or pick another name.",
      not_found: "That profile could not be found.",
    },
  },

  journey: {
    stepsLabel: "Import steps",
    fileMeta: "{{rows}} rows · {{size}}",
    profileTag: "profile {{profile}}",
    discard: "Discard upload",
    columns: "Columns matched",
    continue: "Continue to check",
    continueImport: "Continue to import",
    step: {
      upload: "Upload",
      check: "Check",
      dryRun: "Dry run",
      import: "Import",
    },
    sub: {
      uploadDone: "{{rows}} rows staged",
      checkNeedsProfile: "Choose a mapping profile",
      checkPending: "{{pending}} decisions pending",
      checkPendingDecisions_one: "{{count}} decision pending",
      checkPendingDecisions_other: "{{count}} decisions pending",
      checkBlockingCount_one: "{{count}} blocker",
      checkBlockingCount_other: "{{count}} blockers",
      checkReady: "All decisions made",
      checkClean: "No decisions needed",
      dryRunLocked: "Unlocks when every finding is resolved",
      dryRunReady: "Ready to run",
      dryRunDone: "{{creates}} create · {{rejects}} reject",
      importLocked: "Runs after a clean dry run",
      importReady: "Ready to commit",
      importDone: "Committed",
    },
  },

  landing: {
    uploadContinue: "Upload and continue to check",
    rail: {
      upload: "Stage a UTF-8 CSV to begin",
      check: "Findings and decisions, before anything runs",
      dryRun: "Row-by-row simulation",
      import: "Commit with a message for the permanent record",
    },
    inProgressHeading: "Imports in progress",
    inProgressEmpty: "No imports in progress. Stage a CSV above to begin.",
    rowMeta: "{{rows}} rows · {{size}} · staged {{staged}}",
    resume: "Resume",
    state: {
      needsProfile: "Choose a mapping profile",
      checkPending: "Check pending",
      check: "Check — {{made}} / {{total}} decisions",
      dryRunReady: "Dry run ready",
      importReady: "Import ready",
    },
  },

  finished: {
    heading: "Finished",
    colFinished: "Finished",
    colOutcome: "Outcome",
    imported: "Imported",
    viewRun: "View run",
    delete: "Delete",
    deleteConfirm: "Delete this upload and its staged file?",
    deleteConfirmAction: "Confirm delete",
    deleteCancel: "Cancel",
    deleteNote:
      "Deleting removes the discarded upload and its staged file, and cannot be undone. Imported uploads are never deletable — their file is the run's source of record.",
    errors: {
      notDiscarded: "Only discarded uploads can be deleted.",
    },
  },

  check: {
    heading: "Check findings",
    chooseProfileHeading: "Choose a mapping profile",
    chooseProfileHelp:
      "The check and the dry run classify every row against this profile. Pick the one that matches your file.",
    useProfile: "Continue",
    noProfiles:
      "A mapping profile maps your spreadsheet's columns to description fields — the check and the dry run classify every row against it. This workspace has none yet; create one, then return to check this upload.",
    ledger:
      "Rows are matched by their reference code — the unique identifier each row carries. Accept a finding to import those rows as they are, or fix the file and re-upload.",
    ledgerCount: "{{made}} / {{total}} decisions made",
    noFindings: "No decisions needed — every row is ready. Continue to the dry run.",
    kindDecision: "Decision",
    kindBlocking: "Blocking",
    kindNote: "Note",
    accepted: "Accepted",
    readOnly: "This upload is closed. The check is shown for reference only.",
    noRecord: "No check on record for this upload.",
    accept: "Accept — import as is",
    undo: "Undo",
    howToFix: "How to fix the file",
    fixHint:
      "Fill {{columns}} for these rows in your source file, then discard this upload and <landing>stage the corrected file</landing>.",
    fixHintNoColumns:
      "Fill the missing values in your source file, then discard this upload and <landing>stage the corrected file</landing>.",
    decisionTitle: {
      single: "{{code}} ({{level}}) is missing {{fields}}",
      multiple: "{{count}} {{level}} rows are missing {{fields}}",
    },
    decisionBody:
      "This mapping requires {{fields}} at {{level}} level — the row's place in the hierarchy (collection, series, file, item); these rows leave them blank.",
    cascade: {
      self: "Unresolved, these {{count}} rows will be rejected.",
      descendants: "Unresolved, their {{cascade}} descendant rows are rejected with them.",
      accepted: "These rows will import as they are, counted as warnings on the run.",
    },
    blocking: {
      duplicate: "{{count}} rows share the reference code {{code}}",
      duplicateBody:
        "Rows {{rows}} share {{code}}. Reference codes must be unique, and file order is never taken as evidence of which is correct, so those rows will be rejected. Remove or re-code the duplicates in your source file and <landing>re-upload</landing> — or proceed; they stay out of this import and appear in the rejects CSV.",
      missing: "{{count}} rows have no reference code",
      missingBody:
        "Rows are matched by reference code; {{count}} rows leave it blank and will be rejected. Add a reference code to each, then <landing>re-upload</landing>.",
      unresolvable: "{{count}} rows point to a parent that does not exist ({{parent}})",
      unresolvableBody:
        "The parent {{parent}} is in neither the file nor this workspace, so those rows will be rejected. <landing>Import the container first</landing> and then <landing>re-upload the items</landing>, or correct the parent reference in your source file.",
      cycle: "{{count}} rows form a parent cycle",
      cycleBody:
        "These rows reference one another in a loop, so no order can create them. Break the cycle in your source file and <landing>re-upload</landing>.",
      invalid: "{{count}} rows have invalid values",
      invalidBody:
        "Rows {{rows}} carry a value that fails validation outright — too long, or not valid for its field. They will be rejected whatever you decide above; fix the values in your source file and <landing>re-upload</landing>.",
      rowsMore: "{{shown}} of {{count}} rows shown",
    },
    info: {
      unmapped: "{{count}} columns are not mapped by this profile",
      unmappedBody:
        "{{columns}} — left unbound; their values are not imported. Nothing to do unless that surprises you.",
      unbound: "{{count}} mapped columns are absent from the file",
      unboundBody:
        "{{columns}} — the profile maps these, but the file has no such column. Their target fields stay blank.",
      warning: "{{count}} values were adjusted ({{code}})",
      warningBody:
        "These rows carried values the mapping reshaped or defaulted. They import with a note, never a rejection.",
      warningCode: {
        unknown_vocabulary: "unrecognised vocabulary",
        unparseable_date: "unparseable date",
        uncertain_date: "uncertain date",
        date_day_clamped: "adjusted day",
        reversed_date_range: "reversed date range",
        ambiguous_day_month: "ambiguous day and month",
        carry_forward_no_predecessor: "no value to carry forward",
        missing_source_column: "missing source column",
        separator_collision: "separator collision",
        accepted_missing_required: "accepted missing fields",
      },
    },
    gate: {
      lockedOne: "Dry run is locked — 1 decision still to make above.",
      lockedMany: "Dry run is locked — {{count}} decisions still to make above.",
      unlocked: "All decisions made. The dry run is unlocked.",
      trivial: "No decisions needed. The dry run is unlocked.",
      run: "Continue to dry run",
      runLocked: "Run dry run",
    },
    errors: {
      locked: "Resolve every decision above before running the dry run.",
      runFailed: "The dry-run could not be completed. Try again.",
      notStaged: "This upload can no longer be checked.",
      noProfile: "Choose a mapping profile first.",
      invalidProfile:
        "That profile's mapping is no longer valid. Open it, fix the highlighted items, and try again.",
      unknownFinding: "That finding is no longer present. Reload the check and try again.",
    },
    levels: {
      fonds: "fonds",
      subfonds: "subfonds",
      series: "series",
      subseries: "subseries",
      file: "file",
      item: "item",
      collection: "collection",
      section: "section",
      volume: "volume",
    },
    fieldNames: {
      referenceCode: "reference code",
      title: "title",
      descriptionLevel: "level of description",
      dateExpression: "date",
      dateStart: "start date",
      dateEnd: "end date",
      extent: "extent",
      scopeContent: "scope and content",
      accessConditions: "access conditions",
      language: "language",
      creatorDisplay: "creator",
      repositoryId: "repository",
    },
  },

  report: {
    heading: "Dry-run report",
    runHeading: "Run a dry-run",
    runHelp: "A dry-run classifies every row without writing anything. Review the report, then commit as a separate step.",
    profileLabel: "Mapping profile",
    chooseProfile: "Choose a profile",
    updateExisting: "Update records that already exist",
    run: "Run dry-run",
    rerun: "Re-run dry-run",
    generatedAt: "Generated {{when}}",
    modeUpsert: "Update existing: on — records that already exist will be updated",
    modeCreateOnly: "Update existing: off — records that already exist are skipped",
    creates: "Creates",
    updates: "Updates",
    skips: "Skipped",
    rejects: "Rejects",
    warnings: "Warnings",
    rejectsHeading: "Rejected rows",
    colRow: "Row",
    colReference: "Reference code",
    colTitle: "Title (verbatim)",
    colReason: "Reason",
    downloadRejects: "Download rejects CSV",
    downloadReport: "Download report",
    commitHeading: "Commit",
    commitHelp:
      "Committing writes the reviewed rows to your catalogue as a run — a recorded, reversible execution with its own message and author. Existing records are updated in place, never deleted.",
    commitNote: "Nothing is deleted — existing records are updated in place, never removed.",
    repositoryLabel: "Repository for new records",
    chooseRepository: "Choose a repository",
    repositoryHelp:
      "New descriptions are filed under this repository. Records that already exist keep their own.",
    messageLabel: "Run message",
    messagePlaceholder: "e.g. ACC diezmos inventory, first import",
    messageHelp: "Required. Say what this import is and why — it is recorded with the run.",
    justificationLabel: "Justification (optional)",
    attest: "I have reviewed the dry-run report — {{writes}} writes, {{rejects}} rejects",
    alreadyCommitted: "This upload has been committed.",
    viewRun: "View the run",
    noRepositories:
      "Every catalogue record names the repository that holds the materials — the archive, library, or institution the descriptions belong to. This workspace has none yet; add one, and the import will assign it to every imported record.",
    addRepository: "Add a repository",
    manageRepositories: "Manage repositories",
    commit: "Commit import",
    commitBlocked: {
      notStaged: "This upload is closed.",
      noReport: "<dryRun>Run a dry run</dryRun> first.",
      attest: "Tick the review confirmation above to enable the button.",
    },
    commitErrors: {
      notStaged: "This upload can no longer be committed.",
      noReport: "Run a dry-run first, then commit.",
      messageRequired: "Enter a run message describing this import.",
      noRepository: "Choose a repository for the new records.",
      profileStale:
        "The mapping profile changed since this dry-run. <dryRun>Run a fresh dry-run</dryRun> before committing.",
      decisionsPending:
        "The check has pending decisions. <check>Resolve them</check>, <dryRun>run a fresh dry-run</dryRun>, and then commit.",
      decisionsChanged:
        "The decisions changed since this dry-run. <dryRun>Run a fresh dry-run</dryRun> before committing.",
      alreadyCommitted: "This upload has already been committed. Each upload commits once.",
    },
    warning: {
      parent_change_ignored:
        "The file gives this record a different parent; imports never re-file existing records — the current parent is kept.",
    },
    reason: {
      missing_reference_code: "Reference code missing — row blocked",
      duplicate_reference_code: "Reference code appears more than once in the file",
      unresolvable_parent: "Parent could not be resolved",
      parent_rejected: "Its parent row was rejected",
      parent_cycle: "Parent relationships form a cycle",
      value_too_long: "A value exceeds the maximum length",
      missing_required_field: "A required field is missing",
      invalid_description_level: "Description level not recognised",
      invalid_field: "A field failed validation",
    },
    reasonDetail: {
      missing_required_field: "Required fields missing: {{fields}}",
      parent_rejected: "Its parent row ({{parent}}) was rejected",
      duplicate_reference_code: "Reference code repeated — also on rows {{rows}}",
    },
    errors: {
      noProfile: "Choose a mapping profile to run the dry-run against.",
      invalidProfile: "That profile's mapping is no longer valid. Open it, fix the highlighted items, and try again.",
      runFailed: "The dry-run could not be completed. Try again.",
      notStaged: "This upload can no longer run a dry-run.",
    },
  },

  runs: {
    link: "Runs",
    heading: "Import runs",
    intro:
      "Every committed import is recorded here as a reversible run, with its message, author, and counts.",
    empty: "No runs yet. Commit a dry-run to create one.",
    colMessage: "Message",
    colKind: "Kind",
    colStatus: "Status",
    colCounts: "Counts",
    colCreated: "Started",
    countsSummary:
      "{{created}} created · {{updated}} updated · {{unchanged}} unchanged · {{skipped}} skipped · {{rejected}} rejected",
    revertCountsSummary: "{{reverted}} reverted · {{kept}} kept",
    unchanged: "Unchanged",
    kind: {
      import: "Import",
      revert: "Revert",
    },
    status: {
      pending: "Pending",
      running: "Running",
      complete: "Complete",
      error: "Failed",
    },
  },

  runDetail: {
    back: "Back to runs",
    profile: "Mapping profile",
    profileDeleted: "Deleted profile",
    created: "Started",
    step: "Step: {{step}}",
    starting: "Starting…",
    progressLabel: "Run progress",
    errorHeading: "The run failed",
    countsHeading: "Results",
    pathCapped:
      "{{capped}} records exceed the hierarchy depth the path cache covers. They imported fully; only the internal path cache was skipped.",
    downloadSource: "Download source CSV",
    downloadReport: "Download report",
    downloadRejects: "Download rejects CSV",
    acceptedHeading: "Accepted incompleteness",
    acceptedIntro: "Required-field gaps the operator knowingly imported, per class.",
    acceptedItem: "{{count}} {{level}} rows imported without {{fields}}",
  },

  revert: {
    heading: "Revert this run",
    help: "Reverting undoes this run's changes as a new, recorded run. Records it created are deleted; records it updated are restored to their previous values. Records edited since the run are kept untouched, never overwritten.",
    helpRevertOfRevert: "Reverting a revert re-applies the run it undid. Those changes return as a new, recorded run; records edited since are kept untouched.",
    messageLabel: "Revert message",
    messagePlaceholder: "e.g. Reverting the ACC diezmos import — wrong profile",
    messageHelp: "Required. Say why you are reverting — it is recorded with the revert run.",
    justificationLabel: "Justification (optional)",
    confirm: "I understand this reverts the run's changes and keeps records edited since",
    submit: "Revert run",
    note: "Nothing is forced — records edited since the run are kept and reported, never overwritten.",
    revertsLabel: "Reverts:",
    revertedByLabel: "Reverted by:",
    countsHeading: "Revert results",
    split: "Reverted {{reverted}} · kept {{kept}}",
    deleted: "Deleted",
    restored: "Restored",
    reinserted: "Re-created",
    skippedEdited: "Kept · edited since",
    skippedForeignChildren: "Kept · new child units",
    skippedConflict: "Kept · reference in use",
    downloadReport: "Download revert report",
    errors: {
      revertFailed: "The revert could not be started. Try again.",
      notRevertable: "This run cannot be reverted.",
      notComplete: "This run has not finished, so it cannot be reverted yet.",
      alreadyReverted: "This run has already been reverted.",
      messageRequired: "Enter a message describing this revert.",
    },
  },

  errors: {
    encoding: "The file is not valid UTF-8. Re-export it as UTF-8 and upload again.",
    empty: "The file has no rows to import.",
    unterminatedQuote: "The file has an unclosed quote and cannot be read reliably. Fix the CSV and upload again.",
    duplicateHeaders: "The file has more than one column named {{headers}}. Rename the duplicated columns and upload again.",
    noFile: "Choose a CSV file to upload.",
    uploadFailed: "The upload could not be staged. Try again.",
  },
} as const;
