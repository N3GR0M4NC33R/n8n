import { Container } from '@n8n/di';
import uniqBy from 'lodash/uniqBy';
import type {
	CodexData,
	DocumentationLink,
	ICredentialType,
	ICredentialTypeData,
	INodeCredentialDescription,
	INodePropertyOptions,
	INodeType,
	INodeTypeBaseDescription,
	INodeTypeData,
	INodeTypeDescription,
	INodeTypeNameVersion,
	IVersionedNodeType,
	KnownNodesAndCredentials,
} from 'n8n-workflow';
import { ApplicationError, applyDeclarativeNodeOptionParameters } from 'n8n-workflow';
import * as path from 'path';

import { UnrecognizedCredentialTypeError } from '@/errors/unrecognized-credential-type.error';
import { UnrecognizedNodeTypeError } from '@/errors/unrecognized-node-type.error';
import { Logger } from '@/logging/logger';

import { commonCORSParameters, commonPollingParameters, CUSTOM_NODES_CATEGORY } from './constants';
import { loadClassInIsolation } from './load-class-in-isolation';

function toJSON(this: ICredentialType) {
	return {
		...this,
		authenticate: typeof this.authenticate === 'function' ? {} : this.authenticate,
	};
}

type Codex = {
	categories: string[];
	subcategories: { [subcategory: string]: string[] };
	resources: {
		primaryDocumentation: DocumentationLink[];
		credentialDocumentation: DocumentationLink[];
	};
	alias: string[];
};

export type Types = {
	nodes: INodeTypeBaseDescription[];
	credentials: ICredentialType[];
};

/**
 * Base class for loading n8n nodes and credentials from a directory.
 * Handles the common functionality for resolving paths, loading classes, and managing node and credential types.
 */
export abstract class DirectoryLoader {
	isLazyLoaded = false;

	// Another way of keeping track of the names and versions of a node. This
	// seems to only be used by the installedPackages repository
	loadedNodes: INodeTypeNameVersion[] = [];

	// Stores the loaded descriptions and sourcepaths
	nodeTypes: INodeTypeData = {};

	credentialTypes: ICredentialTypeData = {};

	// Stores the location and classnames of the nodes and credentials that are
	// loaded; used to actually load the files in lazy-loading scenario.
	known: KnownNodesAndCredentials = { nodes: {}, credentials: {} };

	// Stores the different versions with their individual descriptions
	types: Types = { nodes: [], credentials: [] };

	readonly nodesByCredential: Record<string, string[]> = {};

	protected readonly logger = Container.get(Logger);

	constructor(
		readonly directory: string,
		protected excludeNodes: string[] = [],
		protected includeNodes: string[] = [],
	) {}

	abstract packageName: string;

	abstract loadAll(): Promise<void>;

	reset() {
		this.loadedNodes = [];
		this.nodeTypes = {};
		this.credentialTypes = {};
		this.known = { nodes: {}, credentials: {} };
		this.types = { nodes: [], credentials: [] };
	}

	protected resolvePath(file: string) {
		return path.resolve(this.directory, file);
	}

	private loadClass<T>(sourcePath: string) {
		const filePath = this.resolvePath(sourcePath);
		const [className] = path.parse(sourcePath).name.split('.');
		try {
			return loadClassInIsolation<T>(filePath, className);
		} catch (error) {
			throw error instanceof TypeError
				? new ApplicationError(
						'Class could not be found. Please check if the class is named correctly.',
						{ extra: { className } },
					)
				: error;
		}
	}

	/** Loads a nodes class from a file, fixes icons, and augments the codex */
	loadNodeFromFile(filePath: string) {
		const tempNode = this.loadClass<INodeType | IVersionedNodeType>(filePath);
		this.addCodex(tempNode, filePath);

		const nodeType = tempNode.description.name;

		if (this.includeNodes.length && !this.includeNodes.includes(nodeType)) {
			return;
		}

		if (this.excludeNodes.includes(nodeType)) {
			return;
		}

		this.fixIconPaths(tempNode.description, filePath);

		let nodeVersion = 1;
		if ('nodeVersions' in tempNode) {
			for (const versionNode of Object.values(tempNode.nodeVersions)) {
				this.fixIconPaths(versionNode.description, filePath);
			}

			for (const version of Object.values(tempNode.nodeVersions)) {
				this.addLoadOptionsMethods(version);
				this.applySpecialNodeParameters(version);
			}

			const currentVersionNode = tempNode.nodeVersions[tempNode.currentVersion];
			this.addCodex(currentVersionNode, filePath);
			nodeVersion = tempNode.currentVersion;

			if (currentVersionNode.hasOwnProperty('executeSingle')) {
				throw new ApplicationError(
					'"executeSingle" has been removed. Please update the code of this node to use "execute" instead.',
					{ extra: { nodeType } },
				);
			}
		} else {
			this.addLoadOptionsMethods(tempNode);
			this.applySpecialNodeParameters(tempNode);

			// Short renaming to avoid type issues
			nodeVersion = Array.isArray(tempNode.description.version)
				? tempNode.description.version.slice(-1)[0]
				: tempNode.description.version;
		}

		this.known.nodes[nodeType] = {
			className: tempNode.constructor.name,
			sourcePath: filePath,
		};

		this.nodeTypes[nodeType] = {
			type: tempNode,
			sourcePath: filePath,
		};

		this.loadedNodes.push({
			name: nodeType,
			version: nodeVersion,
		});

		this.getVersionedNodeTypeAll(tempNode).forEach(({ description }) => {
			this.types.nodes.push(description);
		});

		for (const credential of this.getCredentialsForNode(tempNode)) {
			if (!this.nodesByCredential[credential.name]) {
				this.nodesByCredential[credential.name] = [];
			}
			this.nodesByCredential[credential.name].push(nodeType);
		}
	}

	getNode(nodeType: string) {
		const {
			nodeTypes,
			known: { nodes: knownNodes },
		} = this;
		if (!(nodeType in nodeTypes) && nodeType in knownNodes) {
			const { sourcePath } = knownNodes[nodeType];
			this.loadNodeFromFile(sourcePath);
		}

		if (nodeType in nodeTypes) {
			return nodeTypes[nodeType];
		}

		throw new UnrecognizedNodeTypeError(this.packageName, nodeType);
	}

	/** Loads a credential class from a file, and fixes icons */
	loadCredentialFromFile(filePath: string): void {
		const tempCredential = this.loadClass<ICredentialType>(filePath);
		// Add serializer method "toJSON" to the class so that authenticate method (if defined)
		// gets mapped to the authenticate attribute before it is sent to the client.
		// The authenticate property is used by the client to decide whether or not to
		// include the credential type in the predefined credentials (HTTP node)
		Object.assign(tempCredential, { toJSON });

		this.fixIconPaths(tempCredential, filePath);

		const credentialType = tempCredential.name;
		this.known.credentials[credentialType] = {
			className: tempCredential.constructor.name,
			sourcePath: filePath,
			extends: tempCredential.extends,
			supportedNodes: this.nodesByCredential[credentialType],
		};

		this.credentialTypes[credentialType] = {
			type: tempCredential,
			sourcePath: filePath,
		};

		this.types.credentials.push(tempCredential);
	}

	getCredential(credentialType: string) {
		const {
			credentialTypes,
			known: { credentials: knownCredentials },
		} = this;
		if (!(credentialType in credentialTypes) && credentialType in knownCredentials) {
			const { sourcePath } = knownCredentials[credentialType];
			this.loadCredentialFromFile(sourcePath);
		}

		if (credentialType in credentialTypes) {
			return credentialTypes[credentialType];
		}

		throw new UnrecognizedCredentialTypeError(credentialType);
	}

	/**
	 * Returns an array of credential descriptions that are supported by a node.
	 * For versioned nodes, combines and deduplicates credentials from all versions.
	 */
	getCredentialsForNode(object: IVersionedNodeType | INodeType): INodeCredentialDescription[] {
		if ('nodeVersions' in object) {
			const credentials = Object.values(object.nodeVersions).flatMap(
				({ description }) => description.credentials ?? [],
			);
			return uniqBy(credentials, 'name');
		}
		return object.description.credentials ?? [];
	}

	/**
	 * Returns an array of all versions of a node type.
	 * For non-versioned nodes, returns an array with just that node.
	 * For versioned nodes, returns all available versions.
	 */
	getVersionedNodeTypeAll(object: IVersionedNodeType | INodeType): INodeType[] {
		if ('nodeVersions' in object) {
			const nodeVersions = Object.values(object.nodeVersions).map((element) => {
				element.description.name = object.description.name;
				element.description.codex = object.description.codex;
				return element;
			});
			return uniqBy(nodeVersions.reverse(), (node) => {
				const { version } = node.description;
				return Array.isArray(version) ? version.join(',') : version.toString();
			});
		}
		return [object];
	}

	/**
	 * Retrieves `categories`, `subcategories` and alias (if defined)
	 * from the codex data for the node at the given file path.
	 */
	private getCodex(filePath: string): CodexData {
		const codexFilePath = this.resolvePath(`${filePath}on`); // .js to .json

		const {
			categories,
			subcategories,
			resources: { primaryDocumentation, credentialDocumentation },
			alias,
		} = module.require(codexFilePath) as Codex;

		return {
			...(categories && { categories }),
			...(subcategories && { subcategories }),
			...(alias && { alias }),
			resources: {
				primaryDocumentation,
				credentialDocumentation,
			},
		};
	}

	/**
	 * Adds a node codex `categories` and `subcategories` (if defined)
	 * to a node description `codex` property.
	 */
	private addCodex(node: INodeType | IVersionedNodeType, filePath: string) {
		const isCustom = this.packageName === 'CUSTOM';
		try {
			let codex;

			if (!isCustom) {
				codex = node.description.codex;
			}

			if (codex === undefined) {
				codex = this.getCodex(filePath);
			}

			if (isCustom) {
				codex.categories = codex.categories
					? codex.categories.concat(CUSTOM_NODES_CATEGORY)
					: [CUSTOM_NODES_CATEGORY];
			}

			node.description.codex = codex;
		} catch {
			this.logger.debug(`No codex available for: ${node.description.name}`);

			if (isCustom) {
				node.description.codex = {
					categories: [CUSTOM_NODES_CATEGORY],
				};
			}
		}
	}

	private addLoadOptionsMethods(node: INodeType) {
		if (node?.methods?.loadOptions) {
			node.description.__loadOptionsMethods = Object.keys(node.methods.loadOptions);
		}
	}

	private applySpecialNodeParameters(nodeType: INodeType): void {
		const { properties, polling, supportsCORS } = nodeType.description;
		if (polling) {
			properties.unshift(...commonPollingParameters);
		}
		if (nodeType.webhook && supportsCORS) {
			const optionsProperty = properties.find(({ name }) => name === 'options');
			if (optionsProperty)
				optionsProperty.options = [
					...commonCORSParameters,
					...(optionsProperty.options as INodePropertyOptions[]),
				];
			else properties.push(...commonCORSParameters);
		}

		applyDeclarativeNodeOptionParameters(nodeType);
	}

	private getIconPath(icon: string, filePath: string) {
		const iconPath = path.join(path.dirname(filePath), icon.replace('file:', ''));
		return `icons/${this.packageName}/${iconPath}`;
	}

	private fixIconPaths(
		obj: INodeTypeDescription | INodeTypeBaseDescription | ICredentialType,
		filePath: string,
	) {
		const { icon } = obj;
		if (!icon) return;

		if (typeof icon === 'string') {
			if (icon.startsWith('file:')) {
				obj.iconUrl = this.getIconPath(icon, filePath);
				obj.icon = undefined;
			}
		} else if (icon.light.startsWith('file:') && icon.dark.startsWith('file:')) {
			obj.iconUrl = {
				light: this.getIconPath(icon.light, filePath),
				dark: this.getIconPath(icon.dark, filePath),
			};
			obj.icon = undefined;
		}
	}
}