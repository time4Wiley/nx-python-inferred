export type PluginOptions = {
  packageManager?: 'poetry' | 'uv';
  inferDependencies?: boolean;
  inferTargets?: boolean;
  // Target name configuration
  lockTargetName?: string;
  addTargetName?: string;
  updateTargetName?: string;
  removeTargetName?: string;
  buildTargetName?: string;
  installTargetName?: string;
  lintTargetName?: string;
  testTargetName?: string;
};
