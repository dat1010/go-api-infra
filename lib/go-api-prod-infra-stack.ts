import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export class GoApiProdInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Lookup the default VPC
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {

      isDefault: true,
    });

    // Add VPC endpoints so tasks in private subnets can access necessary AWS services
    vpc.addInterfaceEndpoint('EcrApiEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
    });

    vpc.addInterfaceEndpoint('EcrDockerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
    });

    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Add a VPC endpoint for CloudWatch Logs to enable logging without public internet access
    vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
    });

    // Add this after your other VPC endpoints
    vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    // Create the ECS Cluster within the VPC
    const cluster = new ecs.Cluster(this, 'GoApiProdCluster', { vpc });

    const authConfigSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GoApiProdAuthConfigSecret',
      'staging/go-api'
    );

    // Create a Fargate service with production-grade configurations
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'GoApiProdFargateService', {
      cluster: cluster,
      cpu: 512,                // Increased CPU allocation
      memoryLimitMiB: 1024,    // Increased memory allocation
      desiredCount: 2,         // More tasks for high availability

      taskImageOptions: {

        image: ecs.ContainerImage.fromRegistry('069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest'),
        containerPort: 8080,
        enableLogging: true,
        secrets: {
          AUTH0_AUDIENCE: ecs.Secret.fromSecretsManager(authConfigSecret, 'AUTH0_AUDIENCE'),
          AUTH0_DOMAIN: ecs.Secret.fromSecretsManager(authConfigSecret, 'AUTH0_DOMAIN'),
          AUTH0_CALLBACK_URL: ecs.Secret.fromSecretsManager(
            authConfigSecret,
            'AUTH0_CALLBACK_URL'
          ),
          AUTH0_CLIENT_ID: ecs.Secret.fromSecretsManager(
            authConfigSecret,
            'AUTH0_CLIENT_ID'
          ),
          AUTH0_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
            authConfigSecret,
            'AUTH0_CLIENT_SECRET'
          ),
          AUTH0_LOGOUT_RETURN_URL: ecs.Secret.fromSecretsManager(
            authConfigSecret,
            'AUTH0_LOGOUT_RETURN_URL'
          ),
        },

      },
      publicLoadBalancer: true,
      assignPublicIp: true, // Change to true temporarily to test connectivity
    });


    // Configure the ALB health check to use /api/healthcheck
    fargateService.targetGroup.configureHealthCheck({
      path: '/api/healthcheck',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    // Enable auto scaling based on CPU utilization for production resiliency
    const scaling = fargateService.service.autoScaleTaskCount({ maxCapacity: 5 });
    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 50,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),

    });

    // Allow ECS tasks to pull images from ECR
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
        resources: [authConfigSecret.secretArn],
      })
    );

    authConfigSecret.grantRead(fargateService.taskDefinition.executionRole!);


    // Output the load balancer DNS so you can easily access the service
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,

    });
  }
}
