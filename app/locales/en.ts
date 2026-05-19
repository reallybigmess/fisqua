/**
 * English Locale Index
 *
 * This module aggregates every namespace under `locales/en/*` into
 * the single resource bundle i18next loads for English users.
 *
 * @version v0.4.0
 */
import type { ResourceLanguage } from "i18next";
import common from "./en/common";
import auth from "./en/auth";
import dashboard from "./en/dashboard";
import viewer from "./en/viewer";
import workflow from "./en/workflow";
import admin from "./en/admin";
import project from "./en/project";
import description from "./en/description";
import comments from "./en/comments";
import sidebar from "./en/sidebar";
import settings from "./en/settings";
import repositories from "./en/repositories";
import entities from "./en/entities";
import places from "./en/places";
import descriptions_admin from "./en/descriptions";
import publish from "./en/publish";
import promote from "./en/promote";
import no_access from "./en/no_access";
import cataloguing_admin from "./en/cataloguing_admin";
import pipeline from "./en/pipeline";
import team from "./en/team";
import vocabularies from "./en/vocabularies";
import volume_admin from "./en/volume_admin";
import user_admin from "./en/user_admin";
import qc_flags from "./en/qc_flags";
import landing from "./en/landing";
import operator from "./en/operator";

export default {
  common,
  auth,
  dashboard,
  viewer,
  workflow,
  admin,
  project,
  description,
  comments,
  sidebar,
  settings,
  repositories,
  entities,
  places,
  descriptions_admin,
  publish,
  promote,
  no_access,
  cataloguing_admin,
  pipeline,
  team,
  vocabularies,
  volume_admin,
  user_admin,
  qc_flags,
  landing,
  operator,
} satisfies ResourceLanguage;
