# Security Policy

## Scope

`pi-bpmn-side-view` parses BPMN 2.0 XML locally with a zero-dependency parser and renders terminal characters inside Pi.

- It does not execute embedded scripts or expressions from BPMN files.
- It does not launch headless browsers or make network requests.
- File watching (`fs.watch`) is scoped only to the explicitly opened `.bpmn` file and closed on panel close or session shutdown.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories at:
https://github.com/henrywen98/pi-bpmn-side-view/security/advisories/new
