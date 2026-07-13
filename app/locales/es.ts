/**
 * Spanish Locale Index
 *
 * This module aggregates every namespace under `locales/es/*` into
 * the single resource bundle i18next loads for Spanish users.
 *
 * @version v0.4.0
 */
import type { ResourceLanguage } from "i18next";
import common from "./es/common";
import auth from "./es/auth";
import dashboard from "./es/dashboard";
import viewer from "./es/viewer";
import workflow from "./es/workflow";
import admin from "./es/admin";
import project from "./es/project";
import description from "./es/description";
import comments from "./es/comments";
import sidebar from "./es/sidebar";
import settings from "./es/settings";
import repositories from "./es/repositories";
import entities from "./es/entities";
import places from "./es/places";
import descriptions_admin from "./es/descriptions";
import publish from "./es/publish";
import promote from "./es/promote";
import no_access from "./es/no_access";
import cataloguing_admin from "./es/cataloguing_admin";
import pipeline from "./es/pipeline";
import team from "./es/team";
import vocabularies from "./es/vocabularies";
import volume_admin from "./es/volume_admin";
import user_admin from "./es/user_admin";
import qc_flags from "./es/qc_flags";
import landing from "./es/landing";
import operator from "./es/operator";
import authorities from "./es/authorities";

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
  authorities,
} satisfies ResourceLanguage;
