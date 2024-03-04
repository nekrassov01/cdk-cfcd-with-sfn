import {
  RemovalPolicy,
  Stack,
  StackProps,
  aws_codebuild as codebuild,
  aws_codecommit as codecommit,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as codepipeline_actions,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
  aws_ssm as ssm,
  aws_stepfunctions as stepfunctions,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface CloudFrontDeploymentSampleCicdStackProps extends StackProps {
  serviceName: string;
  repositoryName: string;
  branch: string;
  addresses: string[];
  buildspecDir: string;
}

export class CloudFrontDeploymentSampleCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudFrontDeploymentSampleCicdStackProps) {
    super(scope, id, props);

    const { serviceName, repositoryName, branch, addresses, buildspecDir } = props;
    const sourceStageName = "Source";
    const buildStageName = "Build";
    const deployStageName = "Deploy";
    const configureStageName = "Configure";
    const approveStageName = "Approve";
    const promoteStageName = "Promote";

    /**
     * Get parameters
     */

    // Get hosting bucket
    const hostingBucketName = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/s3/website`,
      ssm.ParameterValueType.STRING
    );
    const hostingBucket = s3.Bucket.fromBucketName(this, "HostingBucket", hostingBucketName);

    // Get cloudfront log bucket
    const cloudfrontLogBucketName = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/s3/cloudfront-log`,
      ssm.ParameterValueType.STRING
    );
    const cloudfrontLogBucket = s3.Bucket.fromBucketName(this, "CloudFrontLogBucket", cloudfrontLogBucketName);

    // Get cloudfront primary distribution id
    const primaryDistributionId = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/cloudfront/cfcd-primary`,
      ssm.ParameterValueType.STRING
    );

    // Get codecommit repositoryName
    const codeCommitRepository = codecommit.Repository.fromRepositoryName(this, "CodeCommitRepository", repositoryName);

    /**
     * Frontend pipeline
     */

    // Create frontend pipeline artifact output
    const frontendSourceOutput = new codepipeline.Artifact(sourceStageName);
    const frontendBuildOutput = new codepipeline.Artifact(buildStageName);
    const frontendDeployOutput = new codepipeline.Artifact(deployStageName);

    // Create s3 bucket for frontend pipeline artifact
    const frontendArtifactBucket = new s3.Bucket(this, "FrontendArtifactBucket", {
      bucketName: `${serviceName}-pipeline-artifact-frontend`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // Create codebuild project role for frontend build
    const frontendBuildProjectRole = new iam.Role(this, "FrontendBuildProjectRole", {
      roleName: `${serviceName}-frontend-build-project-role`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    // Create codebuild project for frontend build
    const frontendBuildProject = new codebuild.PipelineProject(this, "FrontendBuildProject", {
      projectName: `${serviceName}-frontend-build-project`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.build.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
      },
      environmentVariables: {
        REACT_APP_VERSION_FRONTEND: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/version/frontend`,
        },
      },
      badge: false,
      role: frontendBuildProjectRole,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "FrontendBuildProjectLogGroup", {
            logGroupName: `/${serviceName}/codebuild/frontend-build-project`,
            removalPolicy: RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.THREE_DAYS,
          }),
        },
      },
    });

    // Create codebuild project role for frontend deploy
    const frontendDeployProjectRole = new iam.Role(this, "FrontendDeployProjectRole", {
      roleName: `${serviceName}-frontend-deploy-project-role`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        ["FrontendDeployProjectRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              resources: [hostingBucket.bucketArn, hostingBucket.bucketArn + "/*"],
            }),
          ],
        }),
      },
    });

    // Create codebuild project for frontend deploy
    const frontendDeployProject = new codebuild.PipelineProject(this, "FrontendDeployProject", {
      projectName: `${serviceName}-frontend-deploy-project`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.deploy.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
      },
      environmentVariables: {
        SERVICE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: serviceName,
        },
        BUCKET_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/s3/website`,
        },
        FRONTEND_VERSION: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/version/frontend`,
        },
      },
      badge: false,
      role: frontendDeployProjectRole,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "FrontendDeployProjectLogGroup", {
            logGroupName: `/${serviceName}/codebuild/frontend-deploy-project`,
            removalPolicy: RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.THREE_DAYS,
          }),
        },
      },
    });

    // Create step functions role for cloudfront continuous deployment configuration
    const frontendConfigureSfnRole = new iam.Role(this, "FrontendConfigureSfnRole", {
      roleName: `${serviceName}-frontend-configure-sfn-role`,
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      inlinePolicies: {
        ["FrontendConfigureSfnRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
              resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:CreateDistribution",
                "cloudfront:UpdateDistribution",
                "cloudfront:CopyDistribution",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetContinuousDeploymentPolicy",
                "cloudfront:CreateContinuousDeploymentPolicy",
                "cloudfront:UpdateContinuousDeploymentPolicy",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create step functions state machine for frontend configure
    const frontendConfigureSfn = new stepfunctions.StateMachine(this, "FrontendConfigureSfn", {
      stateMachineName: `${serviceName}-frontend-configure-sfn`,
      definitionBody: stepfunctions.DefinitionBody.fromFile("src/sfn/configure.json", {}),
      role: frontendConfigureSfnRole,
    });

    // Create step functions role for frontend promote
    const frontendPromoteSfnRole = new iam.Role(this, "FrontendPromoteSfnRole", {
      roleName: `${serviceName}-frontend-promote-sfn-role`,
      assumedBy: new iam.ServicePrincipal("states.amazonaws.com"),
      inlinePolicies: {
        ["FrontendPromoteSfnRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
              resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:UpdateDistribution",
                "cloudfront:GetInvalidation",
                "cloudfront:CreateInvalidation",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["cloudfront:GetContinuousDeploymentPolicy"],
              resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "xray:PutTraceSegments",
                "xray:PutTelemetryRecords",
                "xray:GetSamplingRules",
                "xray:GetSamplingTargets",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    // Create step functions state machine for frontend promote
    const frontendPromoteSfn = new stepfunctions.StateMachine(this, "FrontendPromoteSfn", {
      stateMachineName: `${serviceName}-frontend-promote-sfn`,
      definitionBody: stepfunctions.DefinitionBody.fromFile("src/sfn/promote.json", {}),
      role: frontendPromoteSfnRole,
    });

    // Create codecommit role for frontend
    const frontendSourceActionRole = new iam.Role(this, "FrontendSourceActionRole", {
      roleName: `${serviceName}-frontend-source-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create event role for frontend
    const frontendSourceActionEventRole = new iam.Role(this, "FrontendSourceActionEventRole", {
      roleName: `${serviceName}-frontend-source-event-role`,
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
    });

    // Create codebuild build project role for frontend
    const frontendBuildActionRole = new iam.Role(this, "FrontendBuildActionRole", {
      roleName: `${serviceName}-frontend-build-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create codebuild deploy project role for frontend
    const frontendDeployActionRole = new iam.Role(this, "FrontendDeployActionRole", {
      roleName: `${serviceName}-frontend-deploy-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create step functions configure role for frontend
    const frontendConfigureActionRole = new iam.Role(this, "FrontendConfigureActionRole", {
      roleName: `${serviceName}-frontend-configure-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create approve role for frontend
    const frontendApproveActionRole = new iam.Role(this, "FrontendApproveActionRole", {
      roleName: `${serviceName}-frontend-approve-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create step fucntions promote role for frontend
    const frontendPromoteActionRole = new iam.Role(this, "FrontendPromoteActionRole", {
      roleName: `${serviceName}-frontend-promote-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create frontend pipeline action for source stage
    const frontendSourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: sourceStageName,
      repository: codeCommitRepository,
      branch: branch,
      output: frontendSourceOutput,
      role: frontendSourceActionRole,
      runOrder: 1,
      trigger: codepipeline_actions.CodeCommitTrigger.NONE,
    });

    // Create frontend pipeline action for build stag
    const frontendBuildAction = new codepipeline_actions.CodeBuildAction({
      actionName: buildStageName,
      project: frontendBuildProject,
      input: frontendSourceOutput,
      outputs: [frontendBuildOutput],
      role: frontendBuildActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline action for deploy stage
    const frontendDeployAction = new codepipeline_actions.CodeBuildAction({
      actionName: deployStageName,
      project: frontendDeployProject,
      input: frontendBuildOutput,
      outputs: [frontendDeployOutput],
      role: frontendDeployActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline action for configure stage
    const frontendConfigureAction = new codepipeline_actions.StepFunctionInvokeAction({
      actionName: configureStageName,
      stateMachineInput: codepipeline_actions.StateMachineInput.literal({
        ParameterKeyFrontendVersion: `/${serviceName}/version/frontend`,
        ParameterKeyStagingDistributionId: `/${serviceName}/cloudfront/cfcd-staging`,
        PrimaryDistributionId: primaryDistributionId,
      }),
      stateMachine: frontendConfigureSfn,
      role: frontendConfigureActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline action for approval stage
    const frontendApproveAction = new codepipeline_actions.ManualApprovalAction({
      actionName: approveStageName,
      role: frontendApproveActionRole,
      externalEntityLink: `https://us-east-1.console.aws.amazon.com/cloudfront/v3/home#/distributions/${primaryDistributionId}`,
      additionalInformation: `Access the staging distribution with the "aws-cf-cd-staging: true" request header and test your application.
      Once approved, the production distribution configuration will be overridden with staging configuration.`,
      notificationTopic: new sns.Topic(this, "ApprovalStageTopic", {
        topicName: `${serviceName}-frontend-approval-topic`,
        displayName: `${serviceName}-frontend-approval-topic`,
      }),
      notifyEmails: addresses,
      runOrder: 1,
    });

    // Create frontend pipeline action for promote stage
    const frontendPromoteAction = new codepipeline_actions.StepFunctionInvokeAction({
      actionName: promoteStageName,
      stateMachineInput: codepipeline_actions.StateMachineInput.literal({
        ParameterKeyStagingDistributionId: `/${serviceName}/cloudfront/cfcd-staging`,
        PrimaryDistributionId: primaryDistributionId,
      }),
      stateMachine: frontendPromoteSfn,
      role: frontendPromoteActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline role
    const frontendPipelineRole = new iam.Role(this, "FrontendPipelineRole", {
      roleName: `${serviceName}-frontend-pipeline-role`,
      assumedBy: new iam.ServicePrincipal("codepipeline.amazonaws.com"),
      inlinePolicies: {
        ["FrontendPipelineRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["codebuild:BatchGetBuilds", "codebuild:StartBuild"],
              resources: [frontendBuildProject.projectArn, frontendDeployProject.projectArn],
            }),
          ],
        }),
      },
    });

    // Create frontend pipeline
    const frontendPipeline = new codepipeline.Pipeline(this, "FrontendPipeline", {
      pipelineName: `${serviceName}-frontend-pipeline`,
      pipelineType: codepipeline.PipelineType.V2,
      role: frontendPipelineRole,
      artifactBucket: frontendArtifactBucket,
    });
    frontendPipeline.addStage({
      stageName: sourceStageName,
      actions: [frontendSourceAction],
    });
    frontendPipeline.addStage({
      stageName: buildStageName,
      actions: [frontendBuildAction],
    });
    frontendPipeline.addStage({
      stageName: deployStageName,
      actions: [frontendDeployAction],
    });
    frontendPipeline.addStage({
      stageName: configureStageName,
      actions: [frontendConfigureAction],
    });
    frontendPipeline.addStage({
      stageName: approveStageName,
      actions: [frontendApproveAction],
    });
    frontendPipeline.addStage({
      stageName: promoteStageName,
      actions: [frontendPromoteAction],
    });

    // Create eventbridge rule when source change
    const frontendSourceActionEventRule = new events.Rule(this, "FrontendSourceActionEventRule", {
      enabled: true,
      ruleName: `${serviceName}-frontend-source-rule`,
      eventPattern: {
        source: ["aws.codecommit"],
        detailType: ["CodeCommit Repository State Change"],
        resources: [codeCommitRepository.repositoryArn],
        detail: {
          event: ["referenceUpdated"],
          referenceName: [branch],
        },
      },
    });
    frontendSourceActionEventRule.addTarget(
      new events_targets.CodePipeline(frontendPipeline, {
        eventRole: frontendSourceActionEventRole,
      })
    );

    // Add policy to frontend artifact bucket
    frontendArtifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(frontendSourceActionEventRole.roleArn),
          new iam.ArnPrincipal(frontendBuildProjectRole.roleArn),
          new iam.ArnPrincipal(frontendDeployProjectRole.roleArn),
          new iam.ArnPrincipal(frontendConfigureSfnRole.roleArn),
          new iam.ArnPrincipal(frontendPromoteSfnRole.roleArn),
          new iam.ArnPrincipal(frontendPipelineRole.roleArn),
        ],
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [frontendArtifactBucket.bucketArn, frontendArtifactBucket.bucketArn + "/*"],
      })
    );
  }
}
