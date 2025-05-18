import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';

export class GoApiInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Creating VPC
    const vpc = new ec2.Vpc(this, 'GoApiVpc', { maxAzs: 2 });
    // Creating the ECS cluster
    const cluster = new ecs.Cluster(this, 'GoApiCluster', { vpc: vpc });

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

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}

