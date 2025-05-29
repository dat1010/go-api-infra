import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';

export class GoApiInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC and ECS Cluster
    const vpc = new ec2.Vpc(this, 'GoApiVpc', { maxAzs: 2 });
    const cluster = new ecs.Cluster(this, 'GoApiCluster', { vpc });

    // Create a simple Lambda function
    const processDataLambda = new lambda.Function(this, 'ProcessDataLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
    });

    // Allow EventBridge to invoke the Lambda (managed out-of-band)
    processDataLambda.addPermission('AllowEventBridgeInvoke', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `arn:aws:events:${this.region}:${this.account}:rule/*`,
    });

    // Reference existing certificate
    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'APICertificate',
      'arn:aws:acm:us-east-1:069597727371:certificate/146132c0-6175-4ce3-8edf-0d4108d53287'
    );

    // Fargate Service hosting Go API
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      'GoApiFargateService',
      {
        cluster,
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry(
            '069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest'
          ),
          containerPort: 8080,
        },
        publicLoadBalancer: true,
        certificate,
        redirectHTTP: true,
      }
    );

    // Update health check path
    fargateService.targetGroup.configureHealthCheck({
      path: '/api/healthcheck',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    // ECR permissions
    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:GetAuthorizationToken',
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
        ],
        resources: ['*'],
      })
    );

    // Secrets Manager permissions
    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [
          'arn:aws:secretsmanager:us-east-1:069597727371:secret:staging/go-api-3V2g50*',
        ],
      })
    );

    // EventBridge permissions for the task role if needed
    fargateService.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['events:PutRule', 'events:PutTargets', 'events:ListRules', 'events:ListTargetsByRule'],
        resources: [`arn:aws:events:${this.region}:${this.account}:rule/*`],
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'LambdaARN', {
      value: processDataLambda.functionArn,
      description: 'ARN of the Process Data Lambda function',
    });
  }
}
