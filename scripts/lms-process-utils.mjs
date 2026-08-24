export function collectOutput(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  
  return {
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}
