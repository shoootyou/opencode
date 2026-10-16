let files = [
  ...(await Array.fromAsync(new Bun.Glob("src/**/*.test.ts").scan("."))),
  ...(await Array.fromAsync(new Bun.Glob("src/**/*.test.tsx").scan("."))),
].sort()
const randomized = process.argv.includes("--randomize")
const options = process.argv.slice(2).filter((option) => option !== "--randomize")

if (randomized) {
  files = files
    .map((file) => ({ file, order: crypto.getRandomValues(new Uint32Array(1))[0]! }))
    .sort((a, b) => a.order - b.order)
    .map(({ file }) => file)
}

let passed = 0

for (const file of files) {
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=solid",
      "--only-failures",
      "--preload",
      "./happydom.ts",
      ...options,
      file,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const result = await child.exited
  const output = `${await new Response(child.stdout).text()}${await new Response(child.stderr).text()}`

  if (result !== 0) {
    console.error(output)
    process.exit(result)
  }

  passed += Number(output.match(/\n\s*(\d+) pass\n/)?.[1] ?? 0)
}

console.log(`\n${passed} pass\n0 fail\nRan ${files.length} test files${randomized ? " in randomized order" : ""}.`)
