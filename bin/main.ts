#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import "source-map-support/register";
import { CloudFrontDeploymentSampleAppStack } from "../lib/app-stack";
import { CloudFrontDeploymentSampleCicdStack } from "../lib/cicd-stack";

// Get env from environment variables
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Get parameters from context
const app = new App();
const serviceName = app.node.tryGetContext("serviceName");
const hostedZoneName = app.node.tryGetContext("hostedZoneName");
const repositoryName = app.node.tryGetContext("repositoryName");
const branch = app.node.tryGetContext("branch");
const addresses = app.node.tryGetContext("addresses");
const buildspecDir = app.node.tryGetContext("buildspecDir");

// Deploy stacks
const appStack = new CloudFrontDeploymentSampleAppStack(app, "CloudFrontDeploymentSampleAppStack", {
  env: env,
  terminationProtection: false,
  serviceName: serviceName,
  hostedZoneName: hostedZoneName,
});
const cicdStack = new CloudFrontDeploymentSampleCicdStack(app, "CloudFrontDeploymentSampleCicdStack", {
  env: env,
  terminationProtection: false,
  serviceName: serviceName,
  repositoryName: repositoryName,
  branch: branch,
  addresses: addresses,
  buildspecDir: buildspecDir,
});

// Add dependencies
cicdStack.addDependency(appStack);

// Tagging all resources
Tags.of(app).add("Owner", app.node.tryGetContext("owner"));
