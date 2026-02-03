import {
  ImplicitDependency,
  DependencyType,
  CreateDependencies,
  CreateNodesV2,
  CreateNodesContextV2,
  TargetConfiguration,
  createNodesFromFiles,
  logger,
  StaticDependency,
  DynamicDependency,
} from '@nx/devkit';
import { getProvider } from '../provider';
import { PluginOptions } from '../types';
import { glob } from 'glob';
import { dirname, join } from 'node:path';
import { hashFile } from 'nx/src/hasher/file-hasher';
import { readFile } from 'node:fs/promises';
import fs, { readdirSync } from 'node:fs';

const cachedScannedFiles: Record<string, [string, string][]> = {};

const IMPORT_REGEX = /(?:import|from)\s+([a-zA-Z_][\w]*)/g;

// File glob to find all pyproject.toml configuration files
const pyprojectGlob = '**/pyproject.toml';

/**
 * CreateNodesV2 function to infer Python project targets from pyproject.toml files
 */
export const createNodesV2: CreateNodesV2<PluginOptions> = [
  pyprojectGlob,
  async (configFiles, options, context) => {
    return await createNodesFromFiles(
      (configFile, options, context) =>
        createNodesInternal(configFile, options, context),
      configFiles,
      options,
      context,
    );
  },
];

// Re-export as createNodes for Nx 21+ compatibility
export const createNodes = createNodesV2;

async function createNodesInternal(
  configFilePath: string,
  options: PluginOptions,
  context: CreateNodesContextV2,
) {
  // Skip if inferTargets is explicitly disabled
  if (options?.inferTargets === false) {
    return {};
  }

  const projectRoot = dirname(configFilePath);

  // Skip node_modules and other non-project directories
  if (projectRoot.includes('node_modules') || projectRoot.includes('.venv')) {
    return {};
  }

  // Do not create targets if package.json or project.json isn't there
  const siblingFiles = readdirSync(join(context.workspaceRoot, projectRoot));
  if (
    !siblingFiles.includes('package.json') &&
    !siblingFiles.includes('project.json')
  ) {
    return {};
  }

  const packageManager = options?.packageManager ?? 'uv';
  const runCmd = packageManager === 'uv' ? 'uv run' : 'poetry run';
  const lockCmd =
    packageManager === 'uv' ? 'uv lock' : 'poetry lock --no-update';
  const syncCmd = packageManager === 'uv' ? 'uv sync' : 'poetry install';

  // Target names with defaults
  const lockTargetName = options?.lockTargetName ?? 'lock';
  const addTargetName = options?.addTargetName ?? 'add';
  const updateTargetName = options?.updateTargetName ?? 'update';
  const removeTargetName = options?.removeTargetName ?? 'remove';
  const buildTargetName = options?.buildTargetName ?? 'build';
  const installTargetName = options?.installTargetName ?? 'install';
  const lintTargetName = options?.lintTargetName ?? 'lint';
  const testTargetName = options?.testTargetName ?? 'test';

  // Check for tests directory
  const hasTests =
    siblingFiles.includes('tests') || siblingFiles.includes('test');

  // Build targets
  const targets: Record<string, TargetConfiguration> = {};

  // Lock target
  targets[lockTargetName] = {
    executor: '@nxlv/python:run-commands',
    options: {
      command: lockCmd,
      cwd: projectRoot,
    },
  };

  // Add target
  targets[addTargetName] = {
    executor: '@nxlv/python:add',
    options: {},
  };

  // Update target
  targets[updateTargetName] = {
    executor: '@nxlv/python:update',
    options: {},
  };

  // Remove target
  targets[removeTargetName] = {
    executor: '@nxlv/python:remove',
    options: {},
  };

  // Build target
  targets[buildTargetName] = {
    executor: '@nxlv/python:build',
    outputs: ['{projectRoot}/dist'],
    options: {
      outputPath: `${projectRoot}/dist`,
      publish: false,
      lockedVersions: true,
      bundleLocalDependencies: true,
    },
    cache: true,
  };

  // Install target
  targets[installTargetName] = {
    executor: '@nxlv/python:run-commands',
    options: {
      command: syncCmd,
      cwd: projectRoot,
    },
  };

  // Lint target
  targets[lintTargetName] = {
    executor: '@nxlv/python:flake8',
    outputs: [`{workspaceRoot}/reports/${projectRoot}/pylint.txt`],
    options: {
      outputFile: `reports/${projectRoot}/pylint.txt`,
    },
    cache: true,
  };

  // Test target (only if tests directory exists)
  if (hasTests) {
    const testsDir = siblingFiles.includes('tests') ? 'tests/' : 'test/';
    targets[testTargetName] = {
      executor: '@nxlv/python:run-commands',
      outputs: [
        `{workspaceRoot}/reports/${projectRoot}/unittests`,
        `{workspaceRoot}/coverage/${projectRoot}`,
      ],
      options: {
        command: `${runCmd} pytest ${testsDir}`,
        cwd: projectRoot,
      },
      cache: true,
    };
  }

  return {
    projects: {
      [projectRoot]: {
        targets,
      },
    },
  };
}

export const createDependencies: CreateDependencies<PluginOptions> = async (
  options,
  context,
) => {
  const result: Array<
    ImplicitDependency | StaticDependency | DynamicDependency
  > = [];
  const { inferDependencies } = options ?? { inferDependencies: false };
  const provider = await getProvider(
    context.workspaceRoot,
    undefined,
    undefined,
    undefined,
    options,
  );

  const projectModulesMap = new Map<string, string[]>();
  const moduleProjectMap = new Map<string, string>();

  if (inferDependencies) {
    for (const project in context.projects) {
      const modules = provider.getModulesFolders(
        context.projects[project].root,
      );
      projectModulesMap.set(project, modules);
      for (const module of modules) {
        const moduleName = module.split('/').pop();
        if (moduleName) {
          moduleProjectMap.set(moduleName, project);
        }
      }
    }
  }

  for (const project in context.projects) {
    const explicitDeps = provider
      .getDependencies(project, context.projects, context.workspaceRoot)
      .map((dep) => dep.name);

    const implicitDeps: [string, string][] = [];

    if (inferDependencies) {
      const sourceFolders = projectModulesMap.get(project);
      const sourceFoldersPatterns = sourceFolders.map((folder) =>
        join(folder, '**', '*.py'),
      );
      const filesToScan = (
        await glob(sourceFoldersPatterns, {
          cwd: context.workspaceRoot,
          fs,
        })
      ).map((file) => [file, hashFile(file)]);

      logger.verbose(`[${project}] Scanning ${filesToScan.length} files`);

      await Promise.all(
        filesToScan.map(async ([file, hash]) => {
          const hashKey = `${file}-${hash}`;
          const cached = cachedScannedFiles[hashKey];
          if (cached) {
            logger.verbose(
              `[${project}] [${file}] Found cached modules: ${Array.from(cached).join(', ')}`,
            );
            for (const [file, module] of cached) {
              if (moduleProjectMap.has(module)) {
                const project = moduleProjectMap.get(module);
                if (project) {
                  implicitDeps.push([project, file]);
                }
              }
            }
          } else {
            const content = await readFile(file, { encoding: 'utf-8' });
            const fileModules: [string, string][] = [];
            for (const match of content.matchAll(IMPORT_REGEX)) {
              const module = match[1].trim();
              fileModules.push([file, module]);
              logger.verbose(`[${project}] [${file}] Found module: ${module}`);
              if (moduleProjectMap.has(module)) {
                const project = moduleProjectMap.get(module);
                if (project) {
                  implicitDeps.push([project, file]);
                }
              }
            }
            cachedScannedFiles[hashKey] = fileModules;
          }
        }),
      );
    }

    explicitDeps.forEach((dep) => {
      result.push({
        source: project,
        target: dep,
        type: DependencyType.implicit,
      });
    });

    Array.from(implicitDeps)
      .filter(([depProject]) => !explicitDeps.includes(depProject))
      .forEach(([depProject, file]) => {
        result.push({
          source: project,
          target: depProject,
          type: DependencyType.dynamic,
          sourceFile: file,
        });
      });
  }

  return result;
};
