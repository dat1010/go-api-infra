import * as cdk from 'aws-cdk-lib';

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';

export class GoApiProdInfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a VPC with high availability (3 AZs for production)
    const vpc = ec2.Vpc.fromLookup(this, 'ExistingVpc', {
      isDefault: true, // or specify VPC ID or tags

    });

    // Create the ECS Cluster within the VPC
    const cluster = new ecs.Cluster(this, 'GoApiProdCluster', { vpc });

    // Create a Fargate service with production-grade configurations
    const fargateService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'GoApiProdFargateService', {
      cluster: cluster,
      cpu: 512,                // Increased CPU allocation
      memoryLimitMiB: 1024,    // Increased memory allocation
      desiredCount: 2,         // More tasks for high availability
      taskImageOptions: {
        image: ecs.ContainerImage.fromRegistry('069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest'),
        containerPort: 8080,
      },
      publicLoadBalancer: true,
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

    // Output the load balancer DNS so you can easily access the service
    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}

