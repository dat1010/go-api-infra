
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';

export class GoApiInfraStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    //Creating vpc
    const vpc = new ec2.Vpc(this, 'GoApiVpc', { maxAzs: 2 });
    //Creating the actuall ecs cluster
    const cluster = new ecs.Cluster(this, 'GoApiCluster', { vpc: vpc });

    // Creation the fargate service that will hose our docker image/container
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
    });

    // Update the ALB health check to use /api/healthcheck instead of the default "/"
    // we needed to setup this explicit health check because our code base doesn't
    // doesn't return 200 at root or / 
    // This caused our task in our cluster to continuly spin up and fail because it didn't know the
    // api was healthy
    fargateService.targetGroup.configureHealthCheck({
      path: '/api/healthcheck',
      interval: cdk.Duration.seconds(30),
      timeout: cdk.Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
    });

    // This we had to add so our fargate ecs task had access to ecr
    // This script doesn't create the ecr registry. I created it manually with
    // aws ecr create-repository --repository-name go-api
    // That aws cli command created our ecr registry then I pushed it up mannually
    // First we need to tag our image. then push it to ecr
    // docker tag go-api:latest 069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest
    // docker push 069597727371.dkr.ecr.us-east-1.amazonaws.com/go-api:latest
    // This is what we need to do in github actions ^
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

    new cdk.CfnOutput(this, 'LoadBalancerDNS', {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });
  }
}
