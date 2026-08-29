#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = mkdtempSync(join(tmpdir(), "job-pipeline-"));
const dbPath = join(root, "monitor.sqlite");
const profilePath = join(root, "profile.md");
const cliPath = join(root, "mock-openclaw.mjs");
writeFileSync(profilePath, "Chemical engineering, process modeling, Python, controls, experiments.");
writeFileSync(cliPath, `
const args=process.argv.slice(2);
if(args[0]==='agent'){
  const prompt=args[args.indexOf('--message')+1];
  const jobs=JSON.parse(prompt.slice(prompt.indexOf('JOBS\\n')+5));
  const results=jobs.map((job,index)=>({id:job.id,experience:index===0?'entry':'senior',relevance:index===0?'relevant':'not_relevant',experience_evidence:'fixture',relevance_evidence:'fixture'}));
  process.stdout.write(JSON.stringify({payloads:[{text:JSON.stringify({results})}]}));
}else if(args[0]==='message'){process.stdout.write(JSON.stringify({ok:true}));}
else process.exit(2);
`);
chmodSync(cliPath, 0o755);

const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE jobs (
 robot_id TEXT NOT NULL,item_key TEXT NOT NULL,title TEXT NOT NULL,company TEXT NOT NULL DEFAULT '',location TEXT NOT NULL DEFAULT '',job_date TEXT NOT NULL DEFAULT '',url TEXT NOT NULL DEFAULT '',raw_json TEXT NOT NULL,recorded_at TEXT NOT NULL,first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,notification_status TEXT NOT NULL DEFAULT 'accepted',filtered_reason TEXT NOT NULL DEFAULT '',filter_evaluated_at TEXT NOT NULL DEFAULT '',filter_decision_source TEXT NOT NULL DEFAULT '',job_source TEXT NOT NULL DEFAULT 'maxun',region TEXT NOT NULL DEFAULT 'US',experience TEXT NOT NULL DEFAULT 'unranked',relevance TEXT NOT NULL DEFAULT 'unranked',is_current INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(robot_id,item_key)
);
`);
const insert=db.prepare("INSERT INTO jobs(robot_id,item_key,title,company,url,raw_json,recorded_at,first_seen_at,last_seen_at,notification_status,job_source,region) VALUES(?,?,?,?,?,?,?,?,?,'accepted',?,?)");
const now=new Date().toISOString();
insert.run("source","one","Process Engineer","Example","https://jobs.example/one",JSON.stringify({description:"One year experience. Build process models with Python."}),now,now,now,"jobspy","US");
insert.run("source","two","Unrelated Role","Example","https://jobs.example/two",JSON.stringify({description:"Requires 3 years. Legal contract work."}),now,now,now,"jobspy","US");
insert.run("source","three","ROW Process Engineer","Example","https://jobs.example/three",JSON.stringify({description:"One year experience. Build process models with Python."}),now,now,now,"jobspy","ROW");
db.close();

function run(args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[new URL("./job-pipeline.mjs",import.meta.url).pathname,...args],{env:{...process.env,MAXUN_JOB_MONITOR_DB:dbPath,JOB_MONITOR_RELEVANCE_PROFILE:profilePath,OPENCLAW_CLI_PATH:cliPath,JOB_MONITOR_US_RELEVANT_TARGET:"-1001",JOB_MONITOR_LESS_RELEVANT_TARGET:"-1002"}});let out="",err="";child.stdout.on("data",v=>out+=v);child.stderr.on("data",v=>err+=v);child.on("close",code=>code===0?resolve(JSON.parse(out)):reject(new Error(err||out)));});}
const result=await run(["run","--all-current","--source-id","source","--region","US","--batch-size","5"]);
assert.deepEqual(result.scope,{sourceId:"source",region:"US"});
assert.equal(result.evaluation.evaluated,2);
assert.equal(result.delivery.delivered,2);
const checked=new DatabaseSync(dbPath);
assert.deepEqual(checked.prepare("SELECT experience,relevance FROM jobs ORDER BY item_key").all().map(row=>({...row})),[
 {experience:"entry",relevance:"relevant"},
 {experience:"unranked",relevance:"unranked"},
 {experience:"senior",relevance:"not_relevant"},
]);
assert.deepEqual(checked.prepare("SELECT status,COUNT(*) count FROM job_content GROUP BY status").all().map(row=>({...row})),[{status:"ready",count:2}]);
assert.equal(checked.prepare("SELECT COUNT(*) count FROM job_deliveries WHERE status='delivered'").get().count,2);
assert.equal(checked.prepare("SELECT COUNT(*) count FROM job_content WHERE item_key='three'").get().count,0);
checked.close();
process.stdout.write("job pipeline tests passed\n");
