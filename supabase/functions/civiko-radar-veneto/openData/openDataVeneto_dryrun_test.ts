// Local dry-run harness: invokes the CKAN importer directly (no edge call, no secret needed).
import { runOpenDataVenetoDeepImport } from "./openDataVenetoCkanImporter.ts";

Deno.test({
  name: "dry-run open data veneto deep — quality fixes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const r = await runOpenDataVenetoDeepImport({
      dryRun: true,
      import: false,
      limitPerKeyword: 20,
      keywords: ["urbanistica","territorio","mobilità","ambiente","scuole","parcheggi","edifici","strade","geoportale","shp","csv","geojson"],
    });
    const summary = {
      api_mode: r.api_mode,
      packages_found: r.packages_found,
      resources_found: r.resources_found,
      records_normalized: r.records_normalized,
      records_importable: r.records_importable,
      records_importable_dataset: r.records_importable_dataset,
      records_importable_resource: r.records_importable_resource,
      records_rejected_count: r.records_rejected_count,
      records_rejected: r.records_rejected,
      geo_inference_fixed_count: r.geo_inference_fixed_count,
      records_topic_vincoli: r.records_topic_vincoli,
      records_regional_scope: r.records_regional_scope,
      sample_importable_records: r.sample_importable_records,
      records_rejected_sample: r.records_rejected_sample,
      errors: r.errors,
      warnings: r.warnings,
    };
    console.log("DRYRUN_REPORT_JSON_BEGIN");
    console.log(JSON.stringify(summary, null, 2));
    console.log("DRYRUN_REPORT_JSON_END");
  },
});
