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

    // Creating VPC
    const vpc = new ec2.Vpc(this, 'GoApiVpc', { maxAzs: 2 });
    // Creating the ECS cluster
    const cluster = new ecs.Cluster(this, 'GoApiCluster', { vpc: vpc });

    // Create a simple Lambda function
    const processDataLambda = new lambda.Function(this, 'ProcessDataLambda', {
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
def handler(event, context):
    print("Received event:", event)
    return {
        'statusCode': 200,
        'body': 'Event received successfully!'
    }
      `),
    });

    // Reference existing certificate
    const certificate = acm.Certificate.fromCertificateArn(
      this,  
      'APICertificate',  
      'arn:aws:acm:us-east-1:069597727371:certificate/146132c0-6175-4ce3-8edf-0d4108d53287'
    );

    // Creating the Fargate service that will host our docker image/container
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'GoApiFargateService', {
      cluster: cluster,
      cpu: 256,
      memoryLimitMiB: 512,
      desiredCount: 1,
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest'),
        containerPort: 8080,
      },
      publicLoadBalancer: true,
      certificate: certificate,
      redirectHTTP: true, // Optional: Redirects HTTP to HTTPS
    });

    // Update the ALB health check to use /api/healthcheck instead of the default "/"
    fargateService.targetGroup.configureHealthCheck({
      path: '/api/healthcheck',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    // Grant the task execution role permissions to access ECR
    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage"
        ],
        resources: ["*"],
      })
    );

    // Grant the task execution role permissions to access Secrets Manager
    // This allows the task to call secretsmanager:GetSecretValue on your secret ARN.
    fargateService.taskDefinition.addToExecutionRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: ["arn:aws:secretsmanager:us-east-1:069597727371:secret:staging/go-api-3V2g50*"],
      })
    );

    // Grant the task role permissions to call EventBridge
    fargateService.taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'events:PutRule',    // create/update rules
          'events:PutTargets', // attach targets to rules
          // optionally add 'events:DescribeRule', 'events:DeleteRule', etc.
        ],
        resources: [
          // scope as narrowly as you like:
          // 'arn:aws:events:us-east-1:069597727371:rule/my-scheduled-event',
          'arn:aws:events:us-east-1:069597727371:rule/*',
        ],
      })
    );

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });

    // Output the Lambda ARN
    new cdk.CfnOutput(this, 'LambdaARN', {
      value: processDataLambda.functionArn,
      description: 'ARN of the Process Data Lambda function',
    });
  }
}
