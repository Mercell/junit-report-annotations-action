const core = require('@actions/core');
const github = require('@actions/github');
const glob = require('@actions/glob');
const ospath = require('path');
const parser = require('xml2json');
const fs = require('fs');

const MINITEST_TEST_FILE_PATH_RE = new RegExp('\\(Minitest::Assertion\\)[^\/]*((\/[^:]+):(\\d+))', 'm');

(async () => {
    try {
        const testReportsGlob = core.getInput('path');
        const includeSummary = core.getInput('includeSummary');
        const numFailures = core.getInput('numFailures');
        const accessToken = core.getInput('access-token');
        const testSrcPath = core.getInput('testSrcPath');
        const annotationJobName = core.getInput('annotationJobName');
        const globber = await glob.create(testReportsGlob, {followSymbolicLinks: false});

        const commitSha = github.context.sha || core.getInput('commit-sha');
        const commitRepo = github.context.repo;

        console.log(`commitRepo: ${JSON.stringify(commitRepo)}, commitSha: ${commitSha}`);

        let numTests = 0;
        let numSkipped = 0;
        let numFailed = 0;
        let numErrored = 0;
        let testDuration = 0;

        let annotations = [];
        let testFailuresMarkdowns = [];

        for await (const file of globber.globGenerator()) {
            const data = await fs.promises.readFile(file);
            var json = JSON.parse(parser.toJson(data));
            if (json.testsuite) {
                const testsuite = json.testsuite;
                testDuration +=  Number(testsuite.time);
                numTests +=  Number(testsuite.tests);
                numErrored +=  Number(testsuite.errors);
                numFailed +=  Number(testsuite.failures);
                numSkipped +=  Number(testsuite.skipped);
                testFunction = async testcase => {
                    if (annotations.length >= numFailures || !testcase.failure) {
                        return;
                    }

                    let fileMatch = testcase.failure.$t.match(MINITEST_TEST_FILE_PATH_RE);
                    let path = fileMatch ? ospath.relative(process.cwd(), fileMatch[2]) : testSrcPath;
                    let lineNumber = fileMatch ? fileMatch[3] : 0;

                    annotations.push({
                        path: path,
                        start_line: lineNumber,
                        end_line: lineNumber,
                        start_column: 0,
                        end_column: 0,
                        annotation_level: 'failure',
                        message: `Junit test ${testcase.name} failed at ${path}:\n ${testcase.failure.message}`,
                        raw_details: testcase.failure.$t,
                    });
                    testFailuresMarkdowns.push(`Some markdown text: [I'm an inline-style link](https://github.com/Mercell/sd-datahighway/blob/37acd54bcc498dd3d484c3afade0af139536f360/test/datahighway_test.rb#L4)`)
                }

                let testCases = Array.isArray(testsuite.testcase) ? testsuite.testcase : [testsuite.testcase];
                for (const testcase of testCases) {
                    await testFunction(testcase)
                }
            }
        }

        const octokit = new github.GitHub(accessToken);
        const req = {
        ...commitRepo,
        ref: commitSha,
        checkName: annotationJobName
        }
        const res = await octokit.checks.listForRef(req);
    
        const check_run = res.data.check_runs.shift();
        if (!check_run) {
            console.log(`Could not find a check for the job ${annotationJobName}, exiting early`);
            const req = {
                ...commitRepo,
                ref: commitSha,
                }
            const res = await octokit.checks.listForRef(req);
            console.log(JSON.stringify(res));
            return;
        }
    
        const annotation_level = numFailed + numErrored > 0 ? 'failure' : 'notice';
        const junitSummary = `Junit Results ran ${numTests} tests in ${testDuration} seconds. ${numErrored} Errored, ${numFailed} Failed, ${numSkipped} Skipped`;
        const annotation = {
            path: testSrcPath,
            start_line: 0,
            end_line: 0,
            start_column: 0,
            end_column: 0,
            annotation_level,
            message: junitSummary,
        };

        const update_req = {
            ...commitRepo,
            check_run_id: check_run.id,
            output: {
                title: "Junit Results",
                summary: junitSummary,
                text: [junitSummary, ...testFailuresMarkdowns].join("\n\n"),
                annotations: [annotation, ...annotations]
            }
        }
        await octokit.checks.update(update_req);
    } catch (error) {
        console.log(error.message);
        core.setFailed(error.message);
    }
})();
