#!/usr/bin/env node

import AdmZip from "adm-zip";
import esprima from "esprima";
import fs from "fs";
import fetch from "node-fetch";

async function upload(file) {
    const url = "https://abstra-uploads.herokuapp.com/function/upload";
    const response = await fetch(url, {
        method: "POST",
        cache: "no-cache",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}"
    });

    if (response.ok) {
        const responseObject = await response.json();

        const s3_response = await fetch(responseObject.putURL, {
            method: "PUT",
            cache: "no-cache",
            mode: "cors",
            body: file
        });

        if (s3_response.ok) {
            return responseObject.getURL;
        } else {
            throw new Error(s3_response.statusText);
        }
    } else {
        throw new Error(response.statusText);
    }
}

async function deploy(url) {
    const res = await fetch("https://abstra-functions.herokuapp.com/cli", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            path: url.split('/')[url.split("/").length - 1]
        })
    })
    const json = await res.json();
    return json.url;
}

async function compile(file) {
    const parsed = esprima.parseModule(file, { range: true });
    const routes = parsed.body
        .filter(node => node.type === "ExportNamedDeclaration")
        .map(node => {
            switch (node.declaration.type) {
                case "FunctionDeclaration":
                    return {
                        path: node.declaration.id.name,
                        params: node.declaration.params.map(p => p.name),
                        code: file.substring(
                            node.declaration.range[0],
                            node.declaration.range[1]
                        )
                    };
                default:
                    console.error("error");
                    console.error(node);
                    throw new Error("Not implemented yet");
            }
        });

    const packages = parsed.body
        .filter(node => node.type === "ImportDeclaration")
        .map(node => ({
            package: node.source.value,
            importCode: node.specifiers.map(specifier =>
                specifier.type === "ImportSpecifier"
                    ? `const ${specifier.local.name} = require("./${node.source.value}").${specifier.imported.name}`
                    : `const ${specifier.local.name} = require("./${node.source.value}")`
            )
        }));

    const paramsExp = params =>
        params.map(p => `event.queryStringParameters.${p}`).join(", ");
    const caseExp = ({ path, params }) => `
            case "${path}":
                return __respond(await ${path}(${paramsExp(params)}), 200)`;

    const deployableSript = `
${packages.map(p => p.importCode).join("\n")}
${routes.map(r => r.code).join("\n")}

function __respond(body, status) {
    return {
        statusCode: status,
        body: JSON.stringify(body)
    }
}

exports.handler = async (event, context) => {
    const path = event.pathParameters.proxy;
    switch (path) {${routes.map(r => caseExp(r)).join("\n")}
    }
};
`;

    const zip = new AdmZip();
    zip.addFile("index.js", Buffer.alloc(deployableSript.length, deployableSript));

    await Promise.all(
        packages
            .filter(p => !p.package.startsWith("."))
            .map(async pkg => {
                const res = await fetch(`https://unpkg.com/${pkg}`);
                const content = await res.text();
                zip.addFile(`${pkg.package}.js`, content);
            })
    );

    const buffer = zip.toBuffer();
    const url = await upload(buffer);
    const base = await deploy(url);
    console.log("Your functions will be available in a few seconds in:")
    await Promise.all(routes.map(async route => console.log(base + "/" + route.path)));
}

compile(
    fs.readFileSync(process.argv[process.argv.length - 1]).toString()
).catch(console.error);
