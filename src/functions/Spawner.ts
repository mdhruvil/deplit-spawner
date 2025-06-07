import {
  ContainerAppsAPIClient,
  JobExecutionTemplate,
} from "@azure/arm-appcontainers";
import { app, InvocationContext } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";

/**
 * needed values to spwan a new build container
 * - deployment id
 * - project id
 * - github url
 * - branch
 * - project slug
 */

// const testCreate: QueueItem = {
//   githubUrl: "https://github.com/mdhruvil/deplit-zaggonaut.git",
//   branch: "main",
//   projectSlug: "ztest",
// };

type QueueItem = {
  githubUrl: string;
  branch: string;
  projectId: string;
  deploymentId: string;
  gitCommitSha: string;
};

export async function Spawner(
  queueItem: QueueItem,
  context: InvocationContext
): Promise<void> {
  console.log("Queue item:", queueItem);
  const item = queueItem;

  const requiredProperties = [
    "githubUrl",
    "branch",
    "projectId",
    "deploymentId",
    "gitCommitSha",
  ];

  const missingProperties = requiredProperties.filter(
    (property) => !item[property]
  );

  if (missingProperties.length > 0) {
    throw new Error(
      `Missing required properties in queue item: ${missingProperties.join(
        ", "
      )}`
    );
  }

  const requiredEnvVars = [
    "APPCONTAINERS_SUBSCRIPTION_ID",
    "APPCONTAINERS_RESOURCE_GROUP",
    "DEPLIT_BACKEND_API_URL",
    "DEPLIT_API_SIDECAR_KEY",
  ];

  const missingEnvVars = requiredEnvVars.filter(
    (envVar) => !process.env[envVar]
  );
  if (missingEnvVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingEnvVars.join(", ")}`
    );
  }

  const { APPCONTAINERS_SUBSCRIPTION_ID, APPCONTAINERS_RESOURCE_GROUP } =
    process.env;

  const credential = new DefaultAzureCredential();
  const containerAppsClient = new ContainerAppsAPIClient(
    credential,
    APPCONTAINERS_SUBSCRIPTION_ID
  );

  const token = crypto.randomUUID();

  const builderEnv = {
    DEPLIT_REPO_URL: item.githubUrl,
    DEPLIT_BRANCH: item.branch,
    DEPLIT_GIT_COMMIT_SHA: item.gitCommitSha,
    DEPLIT_PROJECT_ID: item.projectId,
    DEPLIT_DEPLOYMENT_ID: item.deploymentId,
    DEPLIT_INTERNAL_SIDECAR_TOKEN: token,
    DEPLIT_SIDECAR_PORT: "9090",
  };

  const sidecarEnv = {
    DEPLIT_INTERNAL_API_TOKEN: token,
    DEPLIT_BACKEND_API_URL: process.env.DEPLIT_BACKEND_API_URL,
    DEPLIT_API_SIDECAR_KEY: process.env.DEPLIT_API_SIDECAR_KEY,
    DEPLIT_DEPLOYMENT_ID: item.deploymentId,
    DEPLIT_PROJECT_ID: item.projectId,
  };

  const template: JobExecutionTemplate = {
    containers: [
      {
        name: "deplit-builder",
        image: "ghcr.io/mdhruvil/deplit-builder:latest",
        resources: {
          cpu: 3,
          memory: "6Gi",
        },
        env: Object.entries(builderEnv).map(([name, value]) => ({
          name,
          value,
        })),
      },
      {
        name: "deplit-sidecar",
        image: "ghcr.io/mdhruvil/deplit-sidecar:latest",
        resources: {
          cpu: 1,
          memory: "2Gi",
        },
        env: Object.entries(sidecarEnv).map(([name, value]) => ({
          name,
          value,
        })),
      },
    ],
  };

  if (process.env.NODE_ENV === "development") {
    console.log("Running in development mode, skipping job creation.");
    builderEnv["NODE_ENV"] = "development";
    sidecarEnv.DEPLIT_BACKEND_API_URL = "http://host.docker.internal:3000";
    const envVars = [
      ...Object.entries(builderEnv).map(([name, value]) => `${name}=${value}`),
      ...Object.entries(sidecarEnv).map(([name, value]) => `${name}=${value}`),
    ].join(" ");
    console.log("Run the following command to start the job locally:");
    console.log(`${envVars} docker compose up`);
    return;
  }

  const jobName = "deplit-builder-job";

  const result = await containerAppsClient.jobs.beginStartAndWait(
    APPCONTAINERS_RESOURCE_GROUP,
    jobName,
    { template }
  );
  console.log(result);
}

app.storageQueue("Spawner", {
  queueName: "deplit-deployment-queue",
  connection: "AzureWebJobsStorage",
  handler: Spawner,
});
